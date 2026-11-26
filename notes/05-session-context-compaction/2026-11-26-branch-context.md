# 2026-11-26：当前分支与压缩记录

## 压缩与读取压缩结果

压缩发生时，旧消息被用于生成摘要，结果写入 compaction 记录。之后构建上下文时，`buildContextEntries()` 读取已有压缩记录并选择记录；它不生成摘要，也不调用模型执行压缩。原始消息仍保留在 Session 历史中。

压缩前已有当前上下文：它由 Session 记录选择当前分支、应用已有摘要和 context_edit 得到，不一定等于文件全部内容。需要压缩时，Pi 准备摘要范围并生成摘要、保存 compaction 记录，再重新构建上下文，供后续请求使用。读取 Session 文件本身不会无条件触发压缩；自动检查发生在运行的相关时机，也可手动触发。

`prepareCompaction()` 先检查当前分支最后一条是否已经是 compaction；是则返回 undefined。否则调用 `buildSessionProjection(pathEntries)`，取得已有压缩和 context_edit 生效后的投影，再准备本次压缩。例如原消息已被替换时，准备摘要使用投影后的内容，而不是忽略已有修改。

寻找切点时，`findProjectedCutPoint()` 先从前往后收集符合条件的候选位置；之后的 token 累计从后往前进行。切点是保留范围的起点：假设 A → B → C → D 在 C 处切，A、B 用于准备摘要，C、D 保留。toolResult 不能直接作为切点，避免从工具结果开始而丢失前面的工具调用。

候选与最终切点是两步：先判断哪些位置允许作为切点并放入 `cutPoints`；再从最新消息往前累计 token，依据近期保留数量选择候选。后续代码还可能调整位置，例如把相邻的非消息元数据一起保留，因此最终 `firstKeptEntryIndex` 不一定始终等于原始候选位置。

默认 `keepRecentTokens` 为 20,000，是希望保留的近期 token 数量，不是上下文窗口的固定百分比；`reserveTokens` 是自动压缩阈值的预留量，两者不同。倒序累计的是每条投影记录的 messages 估算大小：模型切换或标签等记录可能没有上下文消息，估算为 0 时跳过累计，不表示删除记录。

当倒序累计达到 `keepRecentTokens`，代码从候选位置中选第一个大于或等于当前数组位置 `i` 的候选；找不到时使用最后一个候选，然后结束累计。例如候选为 `[1, 3, 5]`，在 `i = 2` 达到目标时选择 `3`。后续仍可能调整最终保留位置。

这里的 `projection` 在这次调用 `buildSessionProjection(pathEntries)` 时重新生成：从 Session 记录整理当前上下文，同时保留消息与原记录的对应关系。`projection.entries` 是逐条结果，每项包含原记录 `sourceEntry` 和对应的投影消息；`projection.messages` 是合并后的上下文消息。结果还包含当前分支的 `thinkingLevel` 和 `model`。从 entries 单独提取 `sourceEntries` 不会撤销 messages 中已经生效的修改。

## 构建上下文的调用链

```text
buildSessionProjection() 接收 Session 记录
→ 调用 buildContextEntries()
  → 找到当前分支 → 查找最新 compaction
  → 没有压缩：返回完整分支路径
  → 有压缩：选择压缩记录、保留尾部和压缩后记录
  → 返回 contextEntries
→ 应用 context_edit，将选出的记录转换为上下文消息
→ 返回投影结果
```

传入的 `entries` 是 Session 原始记录，可包含其他分支和已被摘要概括的旧记录；`contextEntries` 是按当前分支和压缩边界选出的记录数组，还不是模型消息或 payload。

## 保留起点与 system 消息

压缩记录中的 `firstKeptEntryId` 指向从哪条旧记录开始保留；`foundFirstKept` 是遍历时的临时标记，不是压缩记录的字段。它表达保留的连续尾部，不能仅凭一个起点表达“保留 A 原文，只摘要中间的 B、C，再保留 D”。

假设路径为 A → B → C → S(system) → 压缩记录 → D → E，摘要概括 A、B，起点指向 C：

```text
先放入压缩记录 → 从 C 开始收集旧记录，跳过 S → 加入压缩后的 D、E
结果：[压缩记录, C, D, E]
```

压缩记录可以携带压缩时的 system 状态，投影时会将其与摘要转换为上下文消息；压缩之后的新 system 记录仍会被加入。以上为帮助理解的假设例子。

## context_edit

`context_edit` 是追加到 Session 的修改记录，以 `targetId` 指向之前的消息记录。构建上下文时可用 replacement 替换目标内容；replacement 为 null 时省略目标消息。原消息记录不被覆盖，修改记录也保留在 Session 中，重新加载后可以再次应用。

假设消息 ID 11 的内容为“检查整个项目”，追加一条目标为 11、替换内容为“只检查登录模块”的 context_edit：历史保留原消息和修改记录，上下文使用替换后的内容。

`contextEntries` 包含选出的各类 Session 记录，例如 `[压缩记录, 消息 A, 消息 B, 修改记录]`。`buildSessionProjection()` 遍历它，找出其中的 context_edit，按 `targetId` 放入 `edits` 查找表；这一步只整理修改记录，后面转换消息时才应用。它不是在判断用户的新输入是否要求修改。

逐条投影时，`sourceEntry` 是当前原始 Session 记录。`projectContextEntry(sourceEntry, edits.get(sourceEntry.id))` 接收原记录和按 ID 查到的修改记录；没有修改时第二个参数为 `undefined`。函数返回该记录对应的上下文消息数组。保留范围内的旧 compaction 记录不再次生成摘要消息。

### 多次压缩时的顺序

历史发生顺序是旧压缩 C1 在前、新压缩 C2 在后。C2 的摘要基于之前摘要与本次需要概括的消息生成，近期消息不一定全部被概括。构建 `contextEntries` 时，代码先把最新压缩记录 C2 放在数组位置 0，再加入保留范围；这不是改变历史发生顺序。

如果旧压缩记录 C1 恰好也处于保留范围，它会出现在位置大于 0 的地方。投影时判断“记录类型是 compaction 且 index > 0”，成立则令该项 `messages = []`，不再次生成 C1 的摘要消息；C1 原记录及摘要并未删除。C2 位于 index 0，仍会生成摘要消息。如果 C1 不在保留范围内，就不会出现在此数组。

`projectContextEntry()` 先将原记录转为消息；没有修改就直接返回。有修改时返回应用修改后的消息，而不是将修改过程作为说明交给模型。原消息和 context_edit 仍保存在 Session 历史中，供追溯和重建上下文。

有修改时，先检查 `replacement`：它为 `null` 表示省略整条记录产生的消息，函数返回 `[]`；不是把消息内容赋值为 null。非 null 才继续处理替换内容。

角色判断有两层：先确定 user、assistant、toolResult、custom 可以替换内容，其他角色保持原样；再检查 assistant 或 toolResult 的替换内容是否为字符串，是则包装为文本数组。user 和 custom 也会替换，只是不走这一步字符串包装。

## 原记录、投影与上下文消息

假设消息 A、B、C 中只有 B 需要修改：`edits` 表只保存针对 B 的修改；`contextEntries.map()` 逐条处理选出的记录。`projectedEntries` 的每项同时保存 `sourceEntry`（原 Session 记录）和 `messages`（应用修改后的消息数组）。没有修改的消息仍按原内容转换。

最后 `flatMap()` 将各项的 `messages` 合并：结果包含未修改的 A、修改后的 B 和未修改的 C，不包含 B 修改前的原文。原文和修改记录仍在 Session 历史中。合并后的消息也不等于完整历史：其他分支、被摘要替代或被省略的消息可能不在其中。
