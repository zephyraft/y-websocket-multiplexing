# y-websocket-multiplexing

- fork自y-websocket [v1.4.5](https://github.com/yjs/y-websocket/tree/v1.4.5)
- 修改为ts
- 增加ws连接多路复用能力

## y-protocols
### syncProtocol
核心Yjs定义了两种消息类型。
- YjsSyncStep1：包括发送客户端的状态集。当收到时，客户端应以YjsSyncStep2进行回复。
- YjsSyncStep2：包括所有丢失的结构和完整的删除集。当收到时，客户端确信它收到了来自远程客户端的所有信息。

在点对点网络中，你可能想引入一个SyncDone消息类型。双方都应该用SyncStep1来启动连接。
当客户端收到SyncStep2时，它应该用SyncDone回复。当本地客户端同时收到SyncStep2和SyncDone时，就可以保证它与远程客户端同步了。

在客户端-服务器模型中，你要以不同的方式处理这个问题。客户端应该用SyncStep1来启动连接。
当服务器收到SyncStep1时，它应该在SyncStep1之后立即回复SyncStep2。
当客户端收到SyncStep1时，它应该用SyncStep2来回复。在收到SyncStep2之后，服务器可以选择发送一个SyncDone，这样客户端就知道同步已经完成。

这种更精细的同步模型有两个原因。
1. 这个协议可以很容易地在http和websockets的基础上实现。
2. 服务器应该只回复请求，而不是启动它们。因此，有必要由客户端发起同步。

消息的构造。[messageType : varUint, message definition...]。

注意：一条消息不包括房间名称的信息。这必须由上层协议来处理!
