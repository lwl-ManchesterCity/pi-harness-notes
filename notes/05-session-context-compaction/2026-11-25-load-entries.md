# 2026-11-25：将记录加载到 SessionManager

`loadEntriesFromFile()` 返回 `entries` 后，`_setSessionFile()` 将它交给 `_loadEntries()`。找到 header 时，`_loadEntries()` 将记录数组赋给 `fileEntries`，从 header 恢复 `sessionId`。接着检查并执行必要的旧格式迁移；如果发生迁移，持久化模式下会将记录写回当前文件。

`_loadEntries()` 也可以接收调用方直接提供的内存记录，不一定经过文件读取和 header 检查。例如假设调用 `SessionManager.inMemory(..., entries)`，传入的数组只有消息记录、没有 header：函数先创建带新 header 的 Session 内存状态，再把这些记录接在后面。内存模式不会因此创建文件；这些记录原先是否来自文件取决于调用方。

这里的 Session 指 SessionManager 管理的一组会话记录，不等于必须存在的文件。

`_loadEntries()` 最后调用 `_buildIndex()`，先清空旧索引和叶子位置，再按顺序遍历当前记录：跳过 header，建立“记录 ID → 记录”的查找关系，并逐条更新 `leafId`；遍历结束时它指向最后一条非 header 记录。标签记录还会恢复或清除目标记录的标签和时间。

## 已有 Session 的加载链路

```text
找到已有 Session 文件路径
→ _setSessionFile() 检查文件存在
→ 使用预加载记录，或 loadEntriesFromFile() 分块读取并解析 JSONL
→ 检查 header，必要时补文件末尾换行，返回 entries
→ _loadEntries() 保存记录和 Session ID，必要时迁移旧格式
→ _buildIndex() 重建 ID、标签索引和 leafId
→ _setSessionFile() 设置 flushed = true，后续新记录可追加到已有文件
```

空文件会初始化新 header；非空但没有可用记录的文件会报错。调用方也可直接向内存 Session 提供记录，不一定经过文件读取。

## 当前分支

回到较早记录后继续对话，可以形成新分支。假设原路径为 A → B，回到 A 后产生 C、D：历史保留 A → B 和 A → C → D；当前 leaf 是 D 时，从 D 沿 parentId 回溯 C、A，再反转为 A → C → D。B 仍在历史中，但不在当前分支。

构建上下文时先找当前分支，再处理 compaction 和 context edit，生成上下文消息；这不等于删除其他分支的历史。
