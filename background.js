/**
 * Gemini Usage Viewer - Background Service Worker
 * 拡張機能のアイコンクリック時の処理、バックグラウンドでのタブ操作、
 * および content.js との通信を管理します。
 */

// 多重実行を防止するための排他制御フラグ
let isFetching = false; 

chrome.action.onClicked.addListener(async () => {
  // 既にデータ取得処理が進行中の場合はスキップ
  if (isFetching) return;
  isFetching = true;

  // UIをローディング状態（グレー）に更新
  chrome.action.setBadgeBackgroundColor({ color: "#757575" });
  chrome.action.setBadgeText({ text: "..." });
  chrome.action.setTitle({ title: "データを取得中..." });

  const usageUrl = "https://gemini.google.com/usage";
  let targetTabId = null;
  let timeoutId = null;
  let hasInjected = false;

  /**
   * 処理終了時のクリーンアップ関数
   * メモリリークや意図しないイベント発火を防ぐため、登録したリスナーとタイマーをすべて解除する
   */
  const cleanup = () => {
    isFetching = false;
    if (timeoutId) clearTimeout(timeoutId);
    chrome.tabs.onUpdated.removeListener(onTabUpdated);
    chrome.tabs.onRemoved.removeListener(onTabRemoved);
    chrome.runtime.onMessage.removeListener(messageListener);
  };

  /**
   * 1. タブの読み込み状態監視リスナー
   * 対象タブの読み込みが完了（status === 'complete'）した時点でスクリプトを注入する
   */
  const onTabUpdated = (tabId, changeInfo, tab) => {
    if (targetTabId !== null && tabId === targetTabId && changeInfo.status === 'complete') {
      injectContentScript(); 
    }
  };

  /**
   * content.jsを対象タブに注入する関数
   * 二重注入の防止および読み込み監視リスナーの解除を行います
   */
  const injectContentScript = () => {
    if (hasInjected || targetTabId === null) return;
    hasInjected = true;
    chrome.tabs.onUpdated.removeListener(onTabUpdated);

    chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ["content.js"]
    }).catch(err => {
      console.error("スクリプトの注入に失敗しました:", err);
      chrome.action.setBadgeBackgroundColor({ color: "#000000" });
      chrome.action.setBadgeText({ text: "ERR" });
      chrome.action.setTitle({ title: "エラー: 取得失敗" });
      chrome.tabs.remove(targetTabId).catch(() => {}); // エラー時はタブを破棄
      cleanup();
    });
  };

  /**
   * 2. タブ破棄監視リスナー
   * データ取得完了前にユーザーが手動で対象タブを閉じた場合、処理を中断してエラー表示にする
   */
  const onTabRemoved = (tabId) => {
    if (tabId === targetTabId) {
      chrome.action.setBadgeBackgroundColor({ color: "#000000" });
      chrome.action.setBadgeText({ text: "ERR" });
      chrome.action.setTitle({ title: "エラー: タブが閉じられました" });
      cleanup();
    }
  };

  /**
   * 3. メッセージ受信リスナー
   * content.js から取得した使用量データを受信し、バッジの色とテキストに反映する
   */
  const messageListener = function (request, sender) {
    if (request.action === "updateUsage" && sender.tab && sender.tab.id === targetTabId) {
      const badgeText = request.data.badgeText;
      let badgeColor = "#757575"; // デフォルト（グレー）
      
      // バッジのテキストから数字を抽出して色を判定
      if (badgeText === "ERR") {
        badgeColor = "#000000"; // 取得失敗: 黒
      } else {
        const numMatch = badgeText.match(/\d+(?:\.\d+)?/);
        if (numMatch) {
          const percent = parseFloat(numMatch[0]);
          if (percent < 50) badgeColor = "#0F9D58";      // 50%未満: 緑
          else if (percent < 80) badgeColor = "#F4B400"; // 50%以上80%未満: 黄
          else badgeColor = "#DB4437";                   // 80%以上: 赤
        }
      }

      // 取得結果をUIに反映
      chrome.action.setBadgeBackgroundColor({ color: badgeColor });
      chrome.action.setBadgeText({ text: badgeText });
      chrome.action.setTitle({ title: request.data.titleText });

      // 処理完了後、作業用のタブを閉じる
      chrome.tabs.remove(targetTabId).catch(() => {});
      cleanup();
    }
  };

  try {
    // イベントの取りこぼしを防ぐため、タブ作成前に各リスナーを登録
    chrome.tabs.onUpdated.addListener(onTabUpdated);
    chrome.tabs.onRemoved.addListener(onTabRemoved);
    chrome.runtime.onMessage.addListener(messageListener);

    // 4. 全体のタイムアウト処理
    // ネットワーク遅延などで処理が滞留した場合、15秒で強制的に中断する
    timeoutId = setTimeout(() => {
      chrome.action.setBadgeBackgroundColor({ color: "#000000" });
      chrome.action.setBadgeText({ text: "ERR" });
      chrome.action.setTitle({
        title: "エラー: タイムアウト\n\nページの読み込みに時間がかかっています。\nネットワーク環境を確認し、しばらくしてから再度お試しください。"        
      });
      if (targetTabId) {
        chrome.tabs.remove(targetTabId).catch(() => {});
      }
      cleanup();
    }, 15000);

    // ユーザーの作業を妨げないよう、非アクティブでタブを作成
    const targetTab = await chrome.tabs.create({ url: usageUrl, active: false });
    targetTabId = targetTab.id;
    if (targetTabId === undefined) {
      throw new Error("作成したタブのIDを取得できませんでした");
    }

    // タブ作成直後の状態を取得し、レースコンディションや即座のタブ削除に対応する
    const currentTab = await chrome.tabs.get(targetTabId);

    // タブ作成時点で既に読み込みが完了している場合は即座にスクリプトを注入
    if (currentTab.status === 'complete') {
      injectContentScript();
    }

  } catch (error) {
    console.error("タブの準備に失敗しました:", error);
    chrome.action.setBadgeBackgroundColor({ color: "#000000" });
    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setTitle({ title: "エラー: タブ準備失敗" });
    cleanup();
  }
});