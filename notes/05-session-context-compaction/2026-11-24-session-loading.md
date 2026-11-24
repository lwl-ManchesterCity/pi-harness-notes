# 2026-11-24：Session 文件路径与加载

## 文件路径与记录 ID

新建 Session 时，SessionManager 将 Session 目录、创建时的时间和 session ID 拼成 `.jsonl` 文件路径，保存在 `this.sessionFile`。生成路径时不一定已经创建文件；满足首次写入条件后才创建。

`appendMessage()` 返回的 entry ID 用来标识 Session 内的一条记录，不是文件路径。保存消息时，SessionManager 已经持有文件路径，因此 `_persist()` 可以使用它写文件。

恢复旧 Session 时，使用已有文件的原路径，不会用当天时间重新拼出旧路径。例如通过 session ID 查找匹配文件、从列表选择文件，或直接提供文件路径。找到路径后交给 `SessionManager.open()`，构造器再传给 `_setSessionFile()`。

## 加载入口

`_setSessionFile()` 处理并保存传入路径，然后检查文件是否存在。文件存在时，若调用方已提供预加载记录就使用它们，否则调用 `loadEntriesFromFile()` 读取。文件是否存在与读取到的记录是否为空是不同判断。

## 分块读取：pending 与 entries

`loadEntriesFromFile()` 使用 1 MB 的缓冲区逐块读取文件。每次读取后，只取本次实际读到的字节，经 UTF-8 解码后追加到 `pending`。读到文件末尾时，`readSync()` 返回 0，循环结束。分块读取避免先将整个文件的原始文本一次读入内存；解析后的记录仍会保存在内存中。

`pending` 是读取和处理之间暂存文字的地方。代码从中取出完整的行处理，留下未处理完的尾部，供下一次读取时继续拼接。例如读到“第一行换行、第二行的一半”，处理第一行后，第二行的一半留在 `pending`。

`entries` 是成功解析出的 Session 记录数组，不是文件原始文字的完整副本。空行和无法解析的行会跳过，解析后的对象才加入数组。

读取完成后，代码尝试解析 `pending` 剩余内容，即使最后一行没有换行符；然后关闭文件。如果没有解析出记录，返回空数组。

## Session header 检查

Pi 约定第一条解析出的记录是 Session header，用于标识 Session。加载时检查第一条记录的 `type` 是否为 `session`，以及 `id` 是否为字符串；不符合则返回空数组。这只是基本检查，不验证 header 的所有字段或后续所有记录。

读取到文件末尾并通过 header 基本检查后，如果 `pending` 非空，Pi 会在文件末尾补一个换行符，使之后追加的记录另起一行。开始读取时还不知道文件末尾是否缺少换行符；检查 header 后再补，也避免修改没有通过基本检查的文件。这里仅判断 `pending` 非空，不要求最后一行解析成功。最后函数返回解析出的 `entries`。

## 空文件与 Session header

Session 是会话记录，JSONL 文件是保存记录的地方。指定文件存在但没有读到记录时，Pi 检查文件大小：非空则报无效 Session 错误；大小为零则创建新 Session 的内存状态，将 header 写入该文件并设置 `flushed = true`，供后续追加。

Session header 是文件的第一条记录，保存 Session 的基本信息：`type` 标记为 `session`，`version` 是格式版本，`id` 是整个 Session 的 ID，`timestamp` 是创建时间，`cwd` 是工作目录。用户消息和助手回复等作为其他记录接在后面。
