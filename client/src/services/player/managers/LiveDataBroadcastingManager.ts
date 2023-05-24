
import DPlayer from 'dplayer';
import { BMLBrowser, BMLBrowserFontFace } from 'web-bml/client/bml_browser';
import { RemoteControl } from 'web-bml/client/remote_controller_client';
import { decodeTS } from 'web-bml/server/decode_ts';

import router from '@/router';
import PlayerManager from '@/services/player/PlayerManager';
import useChannelsStore from '@/store/ChannelsStore';
import Utils, { PlayerUtils } from '@/utils';


interface IPSIArchivedDataContext {
    pids?: number[];
    dict?: Uint8Array[];
    position?: number;
    trailer_size?: number;
    time_list_count?: number;
    code_list_position?: number;
    code_count?: number;
    init_time?: number;
    curr_time?: number;
}


class LiveDataBroadcastingManager implements PlayerManager {

    private player: DPlayer;
    private display_channel_id: string;
    private container_element: HTMLElement;
    private media_element: HTMLElement;

    // BML ブラウザのインスタンス
    // Vue.js は data() で設定した変数を再帰的に監視するが、BMLBrowser 内の JS-Interpreter のインスタンスが
    // Vue.js の監視対象に入ると謎のエラーが発生してしまうため、プロパティを Hard Private にして監視対象から外す
    #bml_browser: BMLBrowser | null = null;

    // BML ブラウザを破棄中かどうか
    private is_bml_browser_destroying: boolean = false;

    // DPlayer のリサイズを監視する ResizeObserver
    private resize_observer: ResizeObserver;

    // PSI/SI アーカイブデータの読み込みに必要な情報
    private psi_archived_data: Uint8Array = new Uint8Array(0);
    private psi_archived_data_api_abort_controller: AbortController = new AbortController();
    private psi_archived_data_context: IPSIArchivedDataContext = {};
    private ts_packet_counters: {[index: number]: number} = {};

    constructor(options: {
        player: DPlayer;
        display_channel_id: string;
    }) {

        this.player = options.player;
        this.display_channel_id = options.display_channel_id;

        // BML ブラウザが入る DOM 要素
        // DPlayer 内の dplayer-video-wrap の中に動的に追加する (映像レイヤーより下)
        // 要素のスタイルは Watch.vue で定義されている
        this.container_element = document.createElement('div');
        this.container_element.classList.add('dplayer-bml-browser');
        this.container_element = this.player.template.videoWrap.insertAdjacentElement('afterbegin', this.container_element) as HTMLElement;

        // 映像が入る DOM 要素
        // DPlayer 内の dplayer-video-wrap-aspect をそのまま使う (中に映像と字幕が含まれる)
        this.media_element = this.player.template.videoWrapAspect;
    }


    /**
     * LiveDataBroadcastingManager での処理を開始する
     *
     * EDCB Legacy WebUI での実装を参考にした
     * https://github.com/xtne6f/EDCB/blob/work-plus-s-230212/ini/HttpPublic/legacy/util.lua#L444-L497
     */
    public async init(): Promise<void> {

        // BML 用フォント
        const round_gothic: BMLBrowserFontFace = {
            source: 'url("https://cdn.jsdelivr.net/gh/googlefonts/kosugi-maru@main/fonts/webfonts/KosugiMaru-Regular.woff2"), local("sans-serif")',
        };
        const square_gothic: BMLBrowserFontFace = {
            source: 'url("https://cdn.jsdelivr.net/gh/googlefonts/kosugi@main/fonts/webfonts/Kosugi-Regular.woff2"), local("sans-serif")',
        };

        // リモコンを初期化
        const remote_control = new RemoteControl(document.querySelector('.remote-control')!, document.querySelector('.remote-control-receiving-status')!);

        // BML ブラウザの初期化
        const this_ = this;
        this.#bml_browser = new BMLBrowser({
            containerElement: this.container_element,
            mediaElement: document.createElement('p'),  // ダミーの p 要素を渡す
            indicator: remote_control,
            storagePrefix: 'KonomiTV-BMLBrowser_',
            nvramPrefix: 'nvram_',
            broadcasterDatabasePrefix: '',
            videoPlaneModeEnabled: true,
            fonts: {
                roundGothic: round_gothic,
                squareGothic: square_gothic,
            },
            epg: {
                tune(originalNetworkId: number, transportStreamId: number, serviceId: number): boolean {
                    // チャンネルリストから network_id と service_id が一致するチャンネルを探す
                    // transport_stream_id は Mirakurun バックエンドの場合は存在しないため使わない
                    // network_id + service_id だけで一意になる
                    const channels_store = useChannelsStore();
                    for (const channels of Object.values(channels_store.channels_list)) {
                        for (const channel of channels) {
                            if (channel.network_id === originalNetworkId && channel.service_id === serviceId) {
                                // 少し待ってからチャンネルを切り替える（チャンネル切り替え時にデータ放送側から音が鳴る可能性があるため）
                                Utils.sleep(0.5).then(() => router.push({path: `/tv/watch/${channel.display_channel_id}`}));
                                return true;
                            }
                        }
                    }
                    // network_id と service_id が一致するチャンネルが見つからなかった
                    // この場合 BML ブラウザはフリーズ状態になるので、ひとまず他の通知が表示されるまではずっとエラーを表示しておく
                    console.error(`[LiveDataBroadcastingManager] Channel not found (network_id: ${originalNetworkId} / service_id: ${serviceId})`);
                    this_.player.notice(`切り替え先のチャンネルが見つかりませんでした。(network_id: ${originalNetworkId} / service_id: ${serviceId})`, -1, undefined, '#FF6F6A');
                    return false;
                }
            },
            ip: {
                getConnectionType(): number {
                    return 403;
                },
                isIPConnected(): number {
                    // ネットワーク接続に非対応 (対応する場合は 1 を返す)
                    return 0;
                },
            },
            // inputApplication (TODO)
            showErrorMessage(title: string, message: string, code?: string): void {
                // 5秒間エラーメッセージを表示する
                this_.player.notice(`${title}<br>${message} (${code})`, 5000, undefined, '#FF6F6A');
            },
        });
        console.log('[LiveDataBroadcastingManager] BMLBrowser initialized.');

        // リモコンに BML ブラウザを設定
        remote_control.content = this.#bml_browser.content;

        // BML ブラウザの幅と高さ
        let bml_browser_width = 960;
        let bml_browser_height = 540;

        // BML ブラウザがロードされたときのイベント
        this.#bml_browser.addEventListener('load', (event) => {
            console.log('[LiveDataBroadcastingManager] BMLBrowser: load', event.detail);

            // 映像の要素をデータ放送内に移動
            this.moveVideoElementToBMLBrowser();

            // BML ブラウザの要素に幅と高さを設定
            bml_browser_width = event.detail.resolution.width;
            bml_browser_height = event.detail.resolution.height;
            this.container_element.style.setProperty('--bml-browser-width', `${bml_browser_width}px`);
            this.container_element.style.setProperty('--bml-browser-height', `${bml_browser_height}px`);

            // --bml-browser-scale-factor (データ放送画面の拡大/縮小率) を設定
            // データ放送は 960×540 か 720×480 の固定サイズなので、レスポンシブにするために transform: scale() を使っている
            const scale_factor_width = this.player.template.videoWrap.clientWidth / bml_browser_width; // Shadow DOM の元の幅
            const scale_factor_height = this.player.template.videoWrap.clientHeight / bml_browser_height; // Shadow DOM の元の高さ
            const scale_factor = Math.min(scale_factor_width, scale_factor_height);
            this.container_element.style.setProperty('--bml-browser-scale-factor', `${scale_factor}`);
        });

        // BML ブラウザの表示状態が変化したときのイベント
        this.#bml_browser.addEventListener('invisible', (event) => {
            if (event.detail === true) {
                // 非表示状態
                console.log('[LiveDataBroadcastingManager] BMLBrowser: invisible');
                // データ放送内に移動していた映像の要素を DPlayer に戻す
                this.moveVideoElementToDPlayer();
            } else {
                // 表示状態
                console.log('[LiveDataBroadcastingManager] BMLBrowser: visible');
                // 映像の要素をデータ放送内に移動
                this.moveVideoElementToBMLBrowser();
            }
        });

        // BML ブラウザ内の映像のサイズが変化したときのイベント
        this.#bml_browser.addEventListener('videochanged', (event) => {
            console.log('[LiveDataBroadcastingManager] BMLBrowser: videochanged', event.detail);
        });

        // DPlayer のリサイズを監視する ResizeObserver を開始
        this.resize_observer = new ResizeObserver((entries: ResizeObserverEntry[]) => {
            // --bml-browser-scale-factor を再計算
            const entry = entries[0];
            const scale_factor_width = entry.contentRect.width / bml_browser_width; // Shadow DOM の元の幅
            const scale_factor_height = entry.contentRect.height / bml_browser_height; // Shadow DOM の元の高さ
            const scale_factor = Math.min(scale_factor_width, scale_factor_height);
            this.container_element.style.setProperty('--bml-browser-scale-factor', `${scale_factor}`);
        });
        this.resize_observer.observe(this.player.template.videoWrap);

        // TS ストリームのデコードを開始
        // PES (字幕) は mpegts.js / LL-HLS 側で既に対応しているため、BML ブラウザ側では対応しない
        const ts_stream = decodeTS({
            // TS ストリームをデコードした結果を BML ブラウザにそのまま送信
            sendCallback: (message) => this.#bml_browser.emitMessage(message),
        });

        // ライブ PSI/SI アーカイブデータストリーミング API にリクエスト
        // 以降の処理はエンドレスなので非同期で実行
        const api_quality = PlayerUtils.extractAPIQualityFromDPlayer(this.player);
        const api_url = `${Utils.api_base_url}/streams/live/${this.display_channel_id}/${api_quality}/psi-archived-data`;
        fetch(api_url, {signal: this.psi_archived_data_api_abort_controller.signal}).then(async (response) => {

            // ReadableStreamDefaultReader を取得
            const reader = response.body?.getReader();

            let last_pcr = -1;
            while (true) {

                // API から随時データを取得
                const result = await reader.read();
                if (result.done) {
                    console.log('[LiveDataBroadcastingManager] PSI/SI archived data finished.');
                    break;  // ストリームの終端に達した
                }
                // console.log(`[LiveDataBroadcastingManager] PSI/SI archived data received. (length: ${result.value.length})`);

                // 今まで受信した PSI/SI アーカイブデータと結合
                // TODO: サーバー側で psisiarc がリセットされた場合はここでも別途処理を挟む必要があるかも？要調査
                const add_data: Uint8Array = result.value;
                const concat_data = new Uint8Array(this.psi_archived_data.length + add_data.length);
                concat_data.set(this.psi_archived_data);
                concat_data.set(add_data, this.psi_archived_data.length);

                // PSI/SI アーカイブデータから TS パケットを生成し、BML ブラウザに送信
                const psi_archived_data = this.readPSIArchivedDataChunk(concat_data.buffer, 0, (second, psi_ts_packets, pid) => {

                    // PCR (Packet Clock Reference) を取得して送信
                    const pcr = Math.floor(second * 90000);
                    if (last_pcr !== pcr) {
                        this.#bml_browser.emitMessage({
                            type: 'pcr',
                            pcrBase: pcr,
                            pcrExtension: 0,
                        });
                        last_pcr = pcr;
                    }

                    // TS パケットのヘッダを設定してデコード
                    // デコードされた結果は decodeTS() の sendCallback で BML ブラウザに送信される
                    this.setTSPacketHeader(psi_ts_packets, pid);
                    ts_stream.parse(Buffer.from(psi_ts_packets.buffer, psi_ts_packets.byteOffset, psi_ts_packets.byteLength));
                });

                // 今回受信したデータを次回に持ち越す
                if (psi_archived_data) {
                    this.psi_archived_data = new Uint8Array(psi_archived_data);
                }
            }

        }).catch((error) => {
            console.error(error);
        });

        // 処理完了を待たずに返す
        return;
    }


    /**
     * 映像の DOM 要素を DPlayer から BML ブラウザ (データ放送) 内に移動する
     */
    private moveVideoElementToBMLBrowser(): void {

        // BML ブラウザの破棄中にイベントが発火した場合は何もしない
        if (this.is_bml_browser_destroying) {
            return;
        }

        // getVideoElement() に失敗した (=現在データ放送に映像が表示されていない) 場合は何もしない
        if (this.#bml_browser.getVideoElement() === null) {
            return;
        }

        // ダミーで渡した p 要素があれば削除
        if (this.#bml_browser.getVideoElement().firstElementChild instanceof HTMLParagraphElement) {
            this.#bml_browser.getVideoElement().firstElementChild.remove();
        }

        // データ放送内に映像の要素を入れる
        this.#bml_browser.getVideoElement().appendChild(this.media_element);

        // データ放送内での表示用にスタイルを調整
        this.media_element.style.width = '100%';
        this.media_element.style.height = '100%';
        for (const child of this.media_element.children) {
            (child as HTMLElement).style.display = 'block';
            (child as HTMLElement).style.visibility = 'visible';
            if (child instanceof HTMLVideoElement) {
                (child as HTMLVideoElement).style.width = '100%';
                (child as HTMLVideoElement).style.height = '100%';
            }
        }
    }


    /**
     * 映像の DOM 要素を BML ブラウザ (データ放送) から DPlayer 内に移動する
     */
    private moveVideoElementToDPlayer(): void {

        // BML ブラウザの破棄中にイベントが発火した場合は何もしない
        if (this.is_bml_browser_destroying) {
            return;
        }

        // データ放送内に移動していた映像の要素を DPlayer に戻す (BML ブラウザより上のレイヤーに配置)
        // BML ブラウザの破棄前に行う必要がある
        this.player.template.videoWrap.insertBefore(this.media_element, this.container_element.nextElementSibling);

        // データ放送内での表示用に調整していたスタイルを戻す
        this.media_element.style.width = '';
        this.media_element.style.height = '';
        for (const child of this.media_element.children) {
            (child as HTMLElement).style.display = '';
            (child as HTMLElement).style.visibility = '';
            if (child instanceof HTMLVideoElement) {
                (child as HTMLVideoElement).style.width = '';
                (child as HTMLVideoElement).style.height = '';
            }
        }
    }


    /**
     * LiveDataBroadcastingManager での処理を終了し、破棄する
     */
    public async destroy(): Promise<void> {

        // ライブ PSI/SI アーカイブデータストリーミング API のリクエストを中断
        this.psi_archived_data_api_abort_controller.abort();

        // PSI/SI アーカイブデータを破棄
        this.psi_archived_data = new Uint8Array();

        // DPlayer のリサイズを監視する ResizeObserver を終了
        this.resize_observer.disconnect();

        // データ放送内に移動していた映像の要素を DPlayer に戻す
        this.moveVideoElementToDPlayer();

        // BML ブラウザを破棄
        this.is_bml_browser_destroying = true;
        await this.#bml_browser.destroy();
        this.is_bml_browser_destroying = false;
        this.#bml_browser = null;
        console.log('[LiveDataBroadcastingManager] BMLBrowser destroyed.');

        // BML ブラウザの要素を削除
        this.container_element.remove();
    }


    /**
     * ヘッダなしの TS パケットにヘッダを設定する
     * EDCB Legacy WebUI の実装をそのまま移植したもの
     * ref: https://github.com/xtne6f/EDCB/blob/work-plus-s-230212/ini/HttpPublic/legacy/script.js#L125-L134
     *
     * @param psi_ts_packets ヘッダなしの TS パケット
     * @param pid TS パケットの PID
     */
    private setTSPacketHeader(psi_ts_packets: Uint8Array, pid: number): void {
        this.ts_packet_counters[pid] = this.ts_packet_counters[pid] || 0;
        for (let i = 0; i < psi_ts_packets.length; i += 188) {
            psi_ts_packets[i] = 0x47;
            psi_ts_packets[i + 1] = (i > 0 ? 0 : 0x40) | (pid >> 8);
            psi_ts_packets[i + 2] = pid;
            psi_ts_packets[i + 3] = 0x10 | this.ts_packet_counters[pid];
            this.ts_packet_counters[pid] = (this.ts_packet_counters[pid] + 1) & 0xf;
        }
    }


    /**
     * PSI/SI アーカイブデータを読み込み、PSI/SI TS を生成する
     * EDCB Legacy WebUI の実装をそのまま移植したもので、正直どう動いているのか全く理解できていない…
     * ref: https://github.com/xtne6f/EDCB/blob/work-plus-s-230212/ini/HttpPublic/legacy/script.js#L1-L123
     *
     * @param buffer PSI/SI アーカイブデータ
     * @param start_second 読み込みを開始する秒数
     * @param callback PSI/SI アーカイブデータから生成した PSI/SI TS を返すコールバック関数
     * @returns ロード済みの PSI/SI アーカイブデータ（？）
     */
    private readPSIArchivedDataChunk(
        buffer: ArrayBuffer,
        start_second: number,
        callback: (second: number, psi_ts_packets: Uint8Array, pid: number) => void,
    ): ArrayBuffer | null {
        const data = new DataView(buffer);

        if (!this.psi_archived_data_context.pids) {
            this.psi_archived_data_context.pids = [];
            this.psi_archived_data_context.dict = [];
            this.psi_archived_data_context.position = 0;
            this.psi_archived_data_context.trailer_size = 0;
            this.psi_archived_data_context.time_list_count = -1;
            this.psi_archived_data_context.code_list_position = 0;
            this.psi_archived_data_context.code_count = 0;
            this.psi_archived_data_context.init_time = -1;
            this.psi_archived_data_context.curr_time = -1;
        }

        while (data.byteLength - this.psi_archived_data_context.position! >= this.psi_archived_data_context.trailer_size! + 32) {
            let position = this.psi_archived_data_context.position! + this.psi_archived_data_context.trailer_size!;
            const time_list_len = data.getUint16(position + 10, true);
            const dictionary_len = data.getUint16(position + 12, true);
            const dictionary_window_len = data.getUint16(position + 14, true);
            const dictionary_data_size = data.getUint32(position + 16, true);
            const dictionary_buffer_size = data.getUint32(position + 20, true);
            const code_list_len = data.getUint32(position + 24, true);

            if (
                data.getUint32(position) != 0x50737363 ||
                data.getUint32(position + 4) != 0x0d0a9a0a ||
                dictionary_window_len < dictionary_len ||
                dictionary_buffer_size < dictionary_data_size ||
                dictionary_window_len > 65536 - 4096
            ) {
                return null;
            }

            const chunkSize = 32 + time_list_len * 4 + dictionary_len * 2 + Math.ceil(dictionary_data_size / 2) * 2 + code_list_len * 2;

            if (data.byteLength - position < chunkSize) break;

            let time_list_position = position + 32;
            position += 32 + time_list_len * 4;

            if (this.psi_archived_data_context.time_list_count < 0) {
                const pids = [];
                const dict = [];
                let section_list_position = 0;

                for (let i = 0; i < dictionary_len; i++, position += 2) {
                    const codeOrSize = data.getUint16(position, true) - 4096;
                    if (codeOrSize >= 0) {
                        if (codeOrSize >= this.psi_archived_data_context.pids.length || this.psi_archived_data_context.pids[codeOrSize] < 0) {
                            return null;
                        }
                        pids[i] = this.psi_archived_data_context.pids[codeOrSize];
                        dict[i] = this.psi_archived_data_context.dict[codeOrSize];
                        this.psi_archived_data_context.pids[codeOrSize] = -1;
                    } else {
                        pids[i] = codeOrSize;
                        dict[i] = null;
                        section_list_position += 2;
                    }
                }
                section_list_position += position;

                for (let i = 0; i < dictionary_len; i++) {
                    if (pids[i] >= 0) {
                        continue;
                    }
                    const psi = new Uint8Array(data.buffer, section_list_position, pids[i] + 4097);
                    dict[i] = new Uint8Array(Math.ceil((psi.length + 1) / 184) * 188);
                    for (let j = 0, k = 0; k < psi.length; j++, k++) {
                        if (!(j % 188)) {
                            j += 4;
                            if (!k) {
                                dict[i][j++] = 0;
                            }
                        }
                        dict[i][j] = psi[k];
                    }
                    section_list_position += psi.length;
                    pids[i] = data.getUint16(position, true) & 0x1fff;
                    position += 2;
                }

                for (let i = dictionary_len, j = 0; i < dictionary_window_len; j++) {
                    if (j >= this.psi_archived_data_context.pids.length) return null;
                    if (this.psi_archived_data_context.pids[j] < 0) continue;
                    pids[i] = this.psi_archived_data_context.pids[j];
                    dict[i++] = this.psi_archived_data_context.dict[j];
                }
                this.psi_archived_data_context.pids = pids;
                this.psi_archived_data_context.dict = dict;
                this.psi_archived_data_context.time_list_count = 0;
                position = section_list_position + dictionary_data_size % 2;
            } else {
                position += dictionary_len * 2 + Math.ceil(dictionary_data_size / 2) * 2;
            }

            position += this.psi_archived_data_context.code_list_position;
            time_list_position += this.psi_archived_data_context.time_list_count * 4;
            for (; this.psi_archived_data_context.time_list_count < time_list_len; this.psi_archived_data_context.time_list_count++, time_list_position += 4) {
                let init_time = this.psi_archived_data_context.init_time;
                let curr_time = this.psi_archived_data_context.curr_time;
                const absTime = data.getUint32(time_list_position, true);
                if (absTime == 0xffffffff) {
                    curr_time = -1;
                } else if (absTime >= 0x80000000) {
                    curr_time = absTime & 0x3fffffff;
                    if (init_time < 0) {
                        init_time = curr_time;
                    }
                } else {
                    const n = data.getUint16(time_list_position + 2, true) + 1;
                    if (curr_time >= 0) {
                        curr_time += data.getUint16(time_list_position, true);
                        const sec = ((curr_time + 0x40000000 - init_time) & 0x3fffffff) / 11250;
                        if (sec >= (start_second || 0)) {
                            for (; this.psi_archived_data_context.code_count < n; this.psi_archived_data_context.code_count++, position += 2, this.psi_archived_data_context.code_list_position += 2) {
                                const code = data.getUint16(position, true) - 4096;
                                callback(sec, this.psi_archived_data_context.dict[code], this.psi_archived_data_context.pids[code]);
                            }
                            this.psi_archived_data_context.code_count = 0;
                        } else {
                            position += n * 2;
                            this.psi_archived_data_context.code_list_position += n * 2;
                        }
                    } else {
                        position += n * 2;
                        this.psi_archived_data_context.code_list_position += n * 2;
                    }
                }
                this.psi_archived_data_context.init_time = init_time;
                this.psi_archived_data_context.curr_time = curr_time;
            }

            this.psi_archived_data_context.position = position;
            this.psi_archived_data_context.trailer_size = 2 + (2 + chunkSize) % 4;
            this.psi_archived_data_context.time_list_count = -1;
            this.psi_archived_data_context.code_list_position = 0;
            this.psi_archived_data_context.curr_time = -1;
        }
        const ret = data.buffer.slice(this.psi_archived_data_context.position);
        this.psi_archived_data_context.position = 0;
        return ret;
    }
}

export default LiveDataBroadcastingManager;
