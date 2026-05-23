/**
 * Gemini Usage Viewer - Content Script
 * 対象のWebページ（Gemini）に注入され、DOMから使用量データを抽出します。
 * SPA（Single Page Application）特有の動的な要素生成に対応するため、
 * DOMの監視とタイムアウト処理を実装しています。
 */

/**
 * ページ内のDOM要素からGeminiの使用量データを抽出します。
 * UIの変更によって要素が見つからない場合でもエラーで停止しないよう、
 * オプショナルチェイニング(?.)を用いて安全に値を取得します。
 * * @returns {Object|null} 抽出したデータオブジェクト。要素が未生成の場合は null を返す。
 */
function extractData() {
  // 対象となるデータコンテナの要素を取得
  const currentContainer = document.querySelector('[data-test-id="gxu-currently"]');
  const weeklyContainer = document.querySelector('[data-test-id="gxu-weekly"]');

  // 要素がまだDOMに描画されていない場合は処理を中断
  if (!currentContainer || !weeklyContainer) {
    return null; 
  }

  // 各コンテナからテキストデータを抽出（前後の空白は削除）
  // 構造の変更により要素が存在しない場合は空文字列をフォールバックとして使用する
  const currentPercent = currentContainer.querySelector('.gxu-item-header > p')?.innerText.trim() || '';
  const currentReset = currentContainer.querySelector('.reset-time-luminous')?.innerText.trim() || '';
  const weeklyPercent = weeklyContainer.querySelector(':scope > p')?.innerText.trim() || '';
  const weeklyReset = weeklyContainer.querySelector('.reset-time-luminous')?.innerText.trim() || '';

  // 取得した文字列から数値部分を抽出
  const numMatch = currentPercent.match(/\d+(?:\.\d+)?/);
  
  // バッジ表示用のテキストを生成（表示領域の制限のため整数に丸める）
  let badgeText = 'ERR';
  if (numMatch) {
    const roundedPercent = Math.round(parseFloat(numMatch[0]));
    badgeText = roundedPercent + '%';
  }
  
  return {
    // ツールチップ表示用にフォーマットしたテキスト（小数を維持）
    titleText: `【現在の使用量】\n${currentPercent} (${currentReset})\n\n【1週間の上限】\n${weeklyPercent}\n(${weeklyReset})`,
    // バッジ表示用テキスト
    badgeText: badgeText
  };
}

/**
 * データの抽出を試行し、結果をバックグラウンドスクリプトへ送信します。
 * 初回試行、MutationObserverによる変更監視、タイムアウトの3段階で処理を制御します。
 */
new Promise((resolve) => {
  // 1. 初回チェック: ページ読み込み時点で要素が存在するか確認
  const initialData = extractData();
  if (initialData) {
    resolve(initialData);
    return;
  }

  let timeoutId;

  // 2. 動的生成の監視: 要素が存在しない場合、DOMの変化を監視する
  const observer = new MutationObserver((mutations, obs) => {
    const data = extractData();
    if (data) {
      obs.disconnect(); // データ取得完了に伴い監視を解除
      if (timeoutId) clearTimeout(timeoutId); // タイムアウト処理を破棄
      resolve(data);
    }
  });

  // body要素以下のすべての子要素の追加・削除を監視対象とする
  observer.observe(document.body, { childList: true, subtree: true });

  // 3. タイムアウト処理: ネットワーク遅延等で要素が生成されない場合のフェイルセーフ
  // 10秒経過しても取得できない場合は監視を打ち切り、エラー状態を返す
  timeoutId = setTimeout(() => {
    observer.disconnect();
    resolve({ 
      titleText: "エラー: 要素が見つかりません\n\nGeminiの画面仕様が変更された可能性があります。\n拡張機能のアップデートをお待ちください。", 
      badgeText: "ERR" 
    });
  }, 10000);

}).then(data => {
  // 取得したデータ（またはエラー情報）をバックグラウンドスクリプトに送信
  chrome.runtime.sendMessage({ action: "updateUsage", data: data });
});