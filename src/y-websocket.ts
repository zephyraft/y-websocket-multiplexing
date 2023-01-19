/**
 * @module provider/websocket
 */

/* eslint-env browser */

import * as Y from 'yjs'; // eslint-disable-line
import * as bc from 'lib0/broadcastchannel';
import * as time from 'lib0/time';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as authProtocol from 'y-protocols/auth';
import * as awarenessProtocol from 'y-protocols/awareness';
import { Observable } from 'lib0/observable';
import * as math from 'lib0/math';
import * as url from 'lib0/url';

// browser端client使用
// 使用BroadcastChannel 对同浏览器跨tab通信等用例进行支持
// multiplexing 参考 https://github.com/DAlperin/y-websocket

// 定义消息类型

/**
 * Y.Doc 同步
 */
export const messageSync = 0;
/**
 * 查询 Awareness
 */
export const messageQueryAwareness = 3;
/**
 * Awareness 同步
 */
export const messageAwareness = 1;
/**
 * Auth
 */
export const messageAuth = 2;
/**
 * subdoc 同步
 */
export const messageSubDocSync = 4;

// 定义各类型消息处理逻辑
const messageHandlers: Array<
    (
        encoder: encoding.Encoder,
        decoder: decoding.Decoder,
        provider: WebsocketProvider,
        emitSynced: boolean,
        messageType: number,
    ) => void
> = [];

messageHandlers[messageSubDocSync] = (
    encoder,
    decoder,
    provider,
    emitSynced,
    _messageType,
) => {
    const subDocID = decoding.readVarString(decoder);
    encoding.writeVarUint(encoder, messageSync);
    const subDoc = provider.getSubDoc(subDocID);
    if (subDoc) {
        const syncMessageType = syncProtocol.readSyncMessage(
            decoder,
            encoder,
            subDoc,
            provider,
        );
        if (
            emitSynced &&
            syncMessageType === syncProtocol.messageYjsSyncStep2
        ) {
            subDoc.emit('synced', [true]);
        }
    }
};

messageHandlers[messageSync] = (
    encoder,
    decoder,
    provider,
    emitSynced,
    _messageType,
) => {
    encoding.writeVarUint(encoder, messageSync);
    const syncMessageType = syncProtocol.readSyncMessage(
        decoder,
        encoder,
        provider.doc,
        provider,
    );
    if (
        emitSynced &&
        syncMessageType === syncProtocol.messageYjsSyncStep2 &&
        !provider.synced
    ) {
        // 收到SyncStep2，代表当前doc已同步
        provider.synced = true;
    }
};

messageHandlers[messageQueryAwareness] = (
    encoder,
    _decoder,
    provider,
    _emitSynced,
    _messageType,
) => {
    encoding.writeVarUint(encoder, messageAwareness);
    encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(
            provider.awareness,
            Array.from(provider.awareness.getStates().keys()),
        ),
    );
};

messageHandlers[messageAwareness] = (
    _encoder,
    decoder,
    provider,
    _emitSynced,
    _messageType,
) => {
    awarenessProtocol.applyAwarenessUpdate(
        provider.awareness,
        decoding.readVarUint8Array(decoder),
        provider,
    );
};

const permissionDeniedHandler = (provider: WebsocketProvider, reason: string) =>
    console.warn(`Permission denied to access ${provider.url}.\n${reason}`);

messageHandlers[messageAuth] = (
    _encoder,
    decoder,
    provider,
    _emitSynced,
    _messageType,
) => {
    authProtocol.readAuthMessage(decoder, provider.doc, (_ydoc, reason) =>
        permissionDeniedHandler(provider, reason),
    );
};

// @todo - this should depend on awareness.outdatedTime
const messageReconnectTimeout = 30000;

/**
 * 处理消息
 * @param provider wsProvider
 * @param buf 消息内容
 * @param emitSynced 是否发送同步状态，目前bc消息都为false，ws消息为true，意义暂不明确
 */
const readMessage = (
    provider: WebsocketProvider,
    buf: Uint8Array,
    emitSynced: boolean,
) => {
    const decoder = decoding.createDecoder(buf);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);
    const messageHandler = provider.messageHandlers[messageType];
    if (messageHandler) {
        messageHandler(encoder, decoder, provider, emitSynced, messageType);
    } else {
        console.error('Unable to compute message');
    }
    return encoder;
};

/**
 * 建立ws连接
 * @param provider wsProvider
 */
const setupWS = (provider: WebsocketProvider) => {
    if (provider.shouldConnect && provider.ws === null) {
        const websocket = new provider._WS(provider.url);
        websocket.binaryType = 'arraybuffer';
        provider.ws = websocket;
        provider.wsconnecting = true;
        provider.wsconnected = false;
        provider.synced = false;

        websocket.onmessage = (event) => {
            provider.wsLastMessageReceived = time.getUnixTime();
            const encoder = readMessage(
                provider,
                new Uint8Array(event.data),
                true,
            );
            if (encoding.length(encoder) > 1) {
                websocket.send(encoding.toUint8Array(encoder));
            }
        };
        websocket.onerror = (event) => {
            provider.emit('connection-error', [event, provider]);
        };
        websocket.onclose = (event) => {
            provider.emit('connection-close', [event, provider]);
            provider.ws = null;
            provider.wsconnecting = false;
            if (provider.wsconnected) {
                provider.wsconnected = false;
                provider.synced = false;
                // update awareness (all users except local left)
                awarenessProtocol.removeAwarenessStates(
                    provider.awareness,
                    Array.from(provider.awareness.getStates().keys()).filter(
                        (client) => client !== provider.doc.clientID,
                    ),
                    provider,
                );
                provider.emit('status', [
                    {
                        status: 'disconnected',
                    },
                ]);
            } else {
                provider.wsUnsuccessfulReconnects++;
            }
            // Start with no reconnect timeout and increase timeout by
            // using exponential backoff starting with 100ms
            setTimeout(function () {
                setupWS(provider);
                provider.connectBc();
            }, math.min(
                math.pow(2, provider.wsUnsuccessfulReconnects) * 100,
                provider.maxBackoffTime,
            ));
        };
        websocket.onopen = () => {
            provider.wsLastMessageReceived = time.getUnixTime();
            provider.wsconnecting = false;
            provider.wsconnected = true;
            provider.wsUnsuccessfulReconnects = 0;
            provider.emit('status', [
                {
                    status: 'connected',
                },
            ]);
            // always send sync step 1 when connected
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSync);
            syncProtocol.writeSyncStep1(encoder, provider.doc);
            websocket.send(encoding.toUint8Array(encoder));
            // broadcast local awareness state
            if (provider.awareness.getLocalState() !== null) {
                const encoderAwarenessState = encoding.createEncoder();
                encoding.writeVarUint(encoderAwarenessState, messageAwareness);
                encoding.writeVarUint8Array(
                    encoderAwarenessState,
                    awarenessProtocol.encodeAwarenessUpdate(
                        provider.awareness,
                        [provider.doc.clientID],
                    ),
                );
                websocket.send(encoding.toUint8Array(encoderAwarenessState));
            }
        };

        provider.emit('status', [
            {
                status: 'connecting',
            },
        ]);
    }
};

/**
 * 广播消息，同时向ws和bc发送消息
 * @param provider wsProvider
 * @param buf 消息内容
 */
const broadcastMessage = (provider: WebsocketProvider, buf: ArrayBuffer) => {
    if (provider.wsconnected) {
        provider.ws?.send(buf);
    }
    if (provider.bcconnected) {
        bc.publish(provider.bcChannel, buf, provider);
    }
};

/**
 * Websocket Provider for Yjs. Creates a websocket connection to sync the shared document.
 * The document name is attached to the provided url. I.e. the following example
 * creates a websocket connection to http://localhost:1234/my-document-name
 *
 * @example
 *   import * as Y from 'yjs'
 *   import { WebsocketProvider } from 'y-websocket'
 *   const doc = new Y.Doc()
 *   const provider = new WebsocketProvider('http://localhost:1234', 'my-document-name', doc)
 *
 */
export class WebsocketProvider extends Observable<string> {
    /**
     * 当前ws对应的YDoc是否已同步
     * @private
     */
    private _synced: boolean = false;
    /**
     * 重新同步定时任务id
     * 仅当resyncInterval配置时生效
     * @private
     */
    private readonly _resyncInterval: any;
    /**
     * bc广播消息订阅
     * @private
     */
    private readonly _bcSubscriber = (data: ArrayBuffer, origin: any) => {
        if (origin !== this) {
            const encoder = readMessage(this, new Uint8Array(data), false);
            if (encoding.length(encoder) > 1) {
                bc.publish(
                    this.bcChannel,
                    encoding.toUint8Array(encoder),
                    this,
                );
            }
        }
    };
    /**
     * YDoc更新事件处理器
     * Listens to Yjs updates and sends them to remote peers (ws and broadcastchannel)
     * @private
     */
    private readonly _updateHandler = (update: Uint8Array, origin: any) => {
        if (origin !== this) {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSync);
            syncProtocol.writeUpdate(encoder, update);
            broadcastMessage(this, encoding.toUint8Array(encoder));
        }
    };
    /**
     * awareness更新事件处理器
     * @private
     */
    private readonly _awarenessUpdateHandler: (
        changed: any,
        _origin: any,
    ) => void = ({ added, updated, removed }, _origin) => {
        const changedClients = added.concat(updated).concat(removed);
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(
                this.awareness,
                changedClients,
            ),
        );
        broadcastMessage(this, encoding.toUint8Array(encoder));
    };
    /**
     * window unload事件处理器，用于remove awareness
     * @private
     */
    private readonly _unloadHandler = () => {
        awarenessProtocol.removeAwarenessStates(
            this.awareness,
            [this.doc.clientID],
            'window unload',
        );
    };
    /**
     * ws连接检查定时任务id
     * @private
     */
    private readonly _checkInterval = setInterval(() => {
        if (
            this.wsconnected &&
            messageReconnectTimeout <
                time.getUnixTime() - this.wsLastMessageReceived
        ) {
            // no message received in a long time - not even your own awareness
            // updates (which are updated every 15 seconds)
            this.ws?.close();
        }
    }, messageReconnectTimeout / 10);
    /**
     * ws库
     */
    _WS: typeof WebSocket;
    /**
     * 尝试重新连接之前等待的最长时间
     */
    maxBackoffTime: number;
    /**
     * bc名称
     */
    bcChannel: string;
    /**
     * url
     */
    url: string;
    /**
     * ws房间名
     */
    roomname: string;
    /**
     * YDoc实例
     */
    doc: Y.Doc;
    /**
     * awareness实例
     */
    awareness: awarenessProtocol.Awareness;
    /**
     * ws是否已连接
     */
    wsconnected: boolean = false;
    /**
     * ws是否连接中
     */
    wsconnecting: boolean = false;
    /**
     * bc是否已连接
     */
    bcconnected: boolean = false;
    /**
     * 是否禁用bc
     */
    disableBc: boolean;
    /**
     * ws失败次数
     */
    wsUnsuccessfulReconnects: number = 0;
    /**
     * yjs消息处理器
     */
    messageHandlers: ((
        encoder: encoding.Encoder,
        decoder: decoding.Decoder,
        provider: WebsocketProvider,
        emitSynced: boolean,
        messageType: number,
    ) => void)[] = messageHandlers.slice();
    /**
     * ws实例
     */
    ws: WebSocket | null = null;
    /**
     * ws接收到上一条消息的时间
     */
    wsLastMessageReceived: number = 0;
    /**
     * 是否应该建立ws连接
     */
    shouldConnect: boolean;
    /**
     * 子文档
     */
    subdocs = new Map<string, Y.Doc>();
    /**
     * 子文档更新事件处理器
     */
    private _subdocUpdateHandlers = new Map<
        string,
        (update: Uint8Array, origin: any) => void
    >();
    /**
     * 获取SubDoc更新事件处理器
     * @private
     */
    private readonly _getSubDocUpdateHandler = (subDocId: string) => {
        const cacheHandler = this._subdocUpdateHandlers.get(subDocId);
        if (cacheHandler) {
            return cacheHandler;
        }

        const handler = (update: Uint8Array, _origin: any) => {
            const encoder = encoding.createEncoder();
            encoding.writeVarUint(encoder, messageSubDocSync);
            encoding.writeVarString(encoder, subDocId);
            syncProtocol.writeUpdate(encoder, update);
            broadcastMessage(this, encoding.toUint8Array(encoder));
        };
        this._subdocUpdateHandlers.set(subDocId, handler);
        return handler;
    };

    // TODO provider destroy时，需要清理interval
    /**
     * When dealing with subdocs, it is possible to race the websocket connection
     * where we are ready to load subdocuments but the connection is not yet ready to send
     * This function is just a quick and dirty retry function for when we can't be sure
     * if the connection is present
     */
    private readonly _dirtyRetrySend = (
        message: Uint8Array,
        callback: Function,
    ) => {
        const ws = this.ws;
        this._waitForConnection(() => {
            // @ts-ignore
            ws.send(message);
            if (typeof callback !== 'undefined') {
                callback();
            }
        }, 1000);
    };
    private readonly _waitForConnection = (
        callback: Function,
        interval: number,
    ) => {
        const ws = this.ws;
        // console.log("_waitForConnection", ws?.readyState);
        if (ws && ws.readyState === 1) {
            callback();
        } else {
            const that = this;
            // optional: implement backoff for interval here
            setTimeout(function () {
                that._waitForConnection(callback, interval);
            }, interval);
        }
    };

    /**
     * @param {string} serverUrl
     * @param {string} roomname
     * @param {Y.Doc} doc
     * @param {object} [opts]
     * @param {boolean} [opts.connect]
     * @param {awarenessProtocol.Awareness} [opts.awareness]
     * @param {Object<string,string>} [opts.params]
     * @param {typeof WebSocket} [opts.WebSocketPolyfill] Optionall provide a WebSocket polyfill
     * @param {number} [opts.resyncInterval] Request server state every `resyncInterval` milliseconds
     * @param {number} [opts.maxBackoffTime] Maximum amount of time to wait before trying to reconnect (we try to reconnect using exponential backoff)
     * @param {boolean} [opts.disableBc] Disable cross-tab BroadcastChannel communication
     */
    constructor(
        serverUrl: string,
        roomname: string,
        doc: Y.Doc,
        {
            connect = true,
            awareness = new awarenessProtocol.Awareness(doc),
            params = {},
            WebSocketPolyfill = WebSocket,
            resyncInterval = -1,
            maxBackoffTime = 2500,
            disableBc = false,
        } = {},
    ) {
        super();
        // ensure that url is always ends with /
        while (serverUrl[serverUrl.length - 1] === '/') {
            serverUrl = serverUrl.slice(0, serverUrl.length - 1);
        }
        const encodedParams = url.encodeQueryParams(params);
        this.maxBackoffTime = maxBackoffTime;
        this.bcChannel = serverUrl + '/' + roomname;
        this.url =
            serverUrl +
            '/' +
            roomname +
            (encodedParams.length === 0 ? '' : '?' + encodedParams);
        this.roomname = roomname;
        this.doc = doc;
        this._WS = WebSocketPolyfill;
        this.awareness = awareness;
        this.disableBc = disableBc;
        /**
         * Whether to connect to other peers or not
         */
        this.shouldConnect = connect;

        this._resyncInterval = 0;
        if (resyncInterval > 0) {
            this._resyncInterval = setInterval(() => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    // resend sync step 1
                    const encoder = encoding.createEncoder();
                    encoding.writeVarUint(encoder, messageSync);
                    syncProtocol.writeSyncStep1(encoder, doc);
                    this.ws.send(encoding.toUint8Array(encoder));
                }
            }, resyncInterval);
        }

        /**
         * Watch for subdoc events and reconcile local state
         */
        this.doc.on('subdocs', ({ added, removed, loaded }) => {
            added.forEach((subdoc: Y.Doc) => {
                this.subdocs.set(subdoc.guid, subdoc);
            });
            removed.forEach((subdoc: Y.Doc) => {
                subdoc.off('update', this._getSubDocUpdateHandler(subdoc.guid));
                this.subdocs.delete(subdoc.guid);
            });
            loaded.forEach((subdoc: Y.Doc) => {
                // always send sync step 1 when connected
                const encoder = encoding.createEncoder();
                encoding.writeVarUint(encoder, messageSubDocSync);
                encoding.writeVarString(encoder, subdoc.guid);
                syncProtocol.writeSyncStep1(encoder, subdoc);
                if (this.ws) {
                    this._dirtyRetrySend(encoding.toUint8Array(encoder), () => {
                        console.log('registry _getSubDocUpdateHandler');
                        subdoc.on(
                            'update',
                            this._getSubDocUpdateHandler(subdoc.guid),
                        );
                    });
                }
            });
        });

        this.doc.on('update', this._updateHandler);
        if (typeof window !== 'undefined') {
            window.addEventListener('unload', this._unloadHandler);
        } else if (typeof process !== 'undefined') {
            process.on('exit', this._unloadHandler);
        }
        awareness.on('update', this._awarenessUpdateHandler);
        if (connect) {
            this.connect();
        }
    }

    /**
     * @type {boolean}
     */
    get synced() {
        return this._synced;
    }

    set synced(state) {
        if (this._synced !== state) {
            this._synced = state;
            this.emit('synced', [state]);
            this.emit('sync', [state]);
        }
    }

    getSubDoc(id: string) {
        return this.subdocs.get(id);
    }

    destroy() {
        if (this._resyncInterval !== 0) {
            clearInterval(this._resyncInterval);
        }
        clearInterval(this._checkInterval);
        this.disconnect();
        if (typeof window !== 'undefined') {
            window.removeEventListener('unload', this._unloadHandler);
        } else if (typeof process !== 'undefined') {
            process.off('exit', this._unloadHandler);
        }
        this.awareness.off('update', this._awarenessUpdateHandler);
        this.doc.off('update', this._updateHandler);
        super.destroy();
    }

    connectBc() {
        if (this.disableBc) {
            return;
        }
        if (!this.bcconnected) {
            bc.subscribe(this.bcChannel, this._bcSubscriber);
            this.bcconnected = true;
        }
        // send sync step1 to bc
        // write sync step 1
        const encoderSync = encoding.createEncoder();
        encoding.writeVarUint(encoderSync, messageSync);
        syncProtocol.writeSyncStep1(encoderSync, this.doc);
        bc.publish(this.bcChannel, encoding.toUint8Array(encoderSync), this);
        // broadcast local state
        const encoderState = encoding.createEncoder();
        encoding.writeVarUint(encoderState, messageSync);
        syncProtocol.writeSyncStep2(encoderState, this.doc);
        bc.publish(this.bcChannel, encoding.toUint8Array(encoderState), this);
        // write queryAwareness
        const encoderAwarenessQuery = encoding.createEncoder();
        encoding.writeVarUint(encoderAwarenessQuery, messageQueryAwareness);
        bc.publish(
            this.bcChannel,
            encoding.toUint8Array(encoderAwarenessQuery),
            this,
        );
        // broadcast local awareness state
        const encoderAwarenessState = encoding.createEncoder();
        encoding.writeVarUint(encoderAwarenessState, messageAwareness);
        encoding.writeVarUint8Array(
            encoderAwarenessState,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [
                this.doc.clientID,
            ]),
        );
        bc.publish(
            this.bcChannel,
            encoding.toUint8Array(encoderAwarenessState),
            this,
        );

        // sync subdoc
        console.log('this.subdocs', this.subdocs);
        this.subdocs.forEach((subdoc) => {
            // subdoc.off("update", this._getSubDocUpdateHandler(subdoc.guid));
            subdoc.on('update', this._getSubDocUpdateHandler(subdoc.guid));
            // send sync step1 to bc
            // write sync step 1
            const encoderSync = encoding.createEncoder();
            encoding.writeVarUint(encoderSync, messageSubDocSync);
            encoding.writeVarString(encoderSync, subdoc.guid);
            syncProtocol.writeSyncStep1(encoderSync, subdoc);
            bc.publish(
                this.bcChannel,
                encoding.toUint8Array(encoderSync),
                this,
            );
            // broadcast local state
            const encoderState = encoding.createEncoder();
            encoding.writeVarUint(encoderState, messageSubDocSync);
            encoding.writeVarString(encoderState, subdoc.guid);
            syncProtocol.writeSyncStep2(encoderState, subdoc);
            bc.publish(
                this.bcChannel,
                encoding.toUint8Array(encoderState),
                this,
            );
        });
    }

    disconnectBc() {
        // broadcast message with local awareness state set to null (indicating disconnect)
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, messageAwareness);
        encoding.writeVarUint8Array(
            encoder,
            awarenessProtocol.encodeAwarenessUpdate(
                this.awareness,
                [this.doc.clientID],
                new Map(),
            ),
        );
        broadcastMessage(this, encoding.toUint8Array(encoder));
        if (this.bcconnected) {
            bc.unsubscribe(this.bcChannel, this._bcSubscriber);
            this.bcconnected = false;
        }
    }

    disconnect() {
        this.shouldConnect = false;
        this.disconnectBc();
        if (this.ws !== null) {
            this.ws.close();
        }
    }

    connect() {
        this.shouldConnect = true;
        if (!this.wsconnected && this.ws === null) {
            setupWS(this);
            this.connectBc();
        }
    }
}
