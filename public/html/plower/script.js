// 永続化された文書を格納 (LocalStorageからロード)
let persistentDocuments = []; 
// 貼り付け画像からOCR処理で生成された一時文書を格納
let ocrDocuments = []; 

// 言語設定の判定 (日本語以外なら英語モード)
const isEn = !navigator.language.startsWith('ja');

// Tesseract Workerを初期化（OCR処理用）
let worker;

const PREVIEW_MAX_DOCS = 5; // コンテンツ表示エリアに表示する最大ファイル数

// --- LocalStorageからの文書ロードとファイル一覧の表示 ---
function loadDocuments() {
    try {
        const storedDocs = localStorage.getItem('plowerRAGDocs');
        persistentDocuments = storedDocs ? JSON.parse(storedDocs) : [];
        updateFileListDisplay();
    } catch (e) {
        console.error("Failed to load documents from LocalStorage:", e);
        persistentDocuments = [];
    }
}

// --- LocalStorageへの文書保存 ---
function saveDocuments() {
    try {
        localStorage.setItem('plowerRAGDocs', JSON.stringify(persistentDocuments));
    } catch (e) {
        console.error("Failed to save documents to LocalStorage:", e);
    }
}

// LocalStorageをリセットする関数
function resetDocuments() {
    const msgConfirm = isEn 
        ? "Are you sure you want to delete all RAG source documents?\n(This cannot be undone. All uploaded files will be cleared from LocalStorage.)"
        : "本当にRAGソース文書を全て削除しますか？\n（この操作は元に戻せません。アップロードされたファイルがLocalStorageから全て消去されます。）";
    if (confirm(msgConfirm)) {
        try {
            // LocalStorageからキーを削除
            localStorage.removeItem('plowerRAGDocs');
            
            // アプリケーション内のデータをクリア
            persistentDocuments = [];
            ocrDocuments = [];
            document.getElementById('pasteArea').value = '';
            // OCR関連の表示もクリア
            clearOcrDisplay();

            // 同期設定のクリア
            directoryHandle = null;
            if (syncInterval) clearInterval(syncInterval);

            // UIを更新
            updateFileListDisplay(); 
            
            alert(isEn ? "All RAG source documents have been reset." : "RAGソース文書を全てリセットしました。");
        } catch (e) {
            console.error("Failed to reset documents:", e);
            alert(isEn ? "An error occurred during reset." : "リセット中にエラーが発生しました。");
        }
    }
}

// OCR/画像関連の表示をクリアするヘルパー関数
function clearOcrDisplay() {
    // 既存のOCR関連要素をクリア
    // 画像とステータスを両方削除します
    document.querySelectorAll('#fileContent img, #fileContent .ocr-status').forEach(el => el.remove());
}

// --- ファイル一覧表示の更新とクリックイベント設定 ---
function updateFileListDisplay() {
    const fileListUl = document.getElementById('fileListUl');
    const fileContentDiv = document.getElementById('fileContent');
    fileListUl.innerHTML = '';
    
    // ファイル名のリストを生成
    persistentDocuments.forEach((doc, index) => {
        const li = document.createElement('li');
        
        // モバイル対応: レイアウトをFlexにしてメニューボタンを追加
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = doc.name;
        nameSpan.style.flexGrow = '1';
        nameSpan.style.overflow = 'hidden';
        nameSpan.style.textOverflow = 'ellipsis';
        nameSpan.style.whiteSpace = 'nowrap';
        li.appendChild(nameSpan);

        // メニューボタン (︙)
        const menuBtn = document.createElement('span');
        menuBtn.innerHTML = '&#x22EE;'; // 縦の三点リーダー
        menuBtn.style.cursor = 'pointer';
        menuBtn.style.padding = '0 5px 0 10px';
        menuBtn.style.fontSize = '1.2em';
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            const rect = e.target.getBoundingClientRect();
            createContextMenu({ pageX: rect.left + window.scrollX, pageY: rect.bottom + window.scrollY, preventDefault: () => {} }, index);
        };
        li.appendChild(menuBtn);

        li.title = doc.name; // ホバーでフルネームを表示
        li.dataset.docIndex = index;
        li.onclick = () => {
            clearOcrDisplay();
            showDocumentContent(index);
        };
        // 右クリックメニュー (コンテキストメニュー) の追加
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            createContextMenu(e, index);
        });
        fileListUl.appendChild(li);
    });
    
    // コンテンツ表示エリアの初期表示（最新の数ファイル）
    let initialContent = isEn ? '<h3>RAG Source Document Preview (Latest 5)</h3>\n' : '<h3>RAGソース文書プレビュー (最新5件)</h3>\n';
    const recentDocs = persistentDocuments.slice(-PREVIEW_MAX_DOCS).reverse();
    
    if (recentDocs.length > 0) {
        recentDocs.forEach(doc => {
            // ファイル名と内容を分かりやすく表示
            initialContent += `<p><strong>【${doc.name}】</strong></p><pre>--- ${isEn ? 'File Name' : 'ファイル名'}: ${doc.name} ---\n${doc.content.slice(0, 300)}${doc.content.length > 300 ? '...' : ''}</pre>\n`;
        });
    } else {
        initialContent += isEn ? '<p>No RAG source documents available.</p>' : '<p>現在RAGのソースとなる文書はありません。</p>';
    }
    fileContentDiv.innerHTML = initialContent;
    
    // OCRで残っている画像やステータスがあれば再挿入（これは初期表示時のみの特殊な対応）
    // clearOcrDisplay() でクリアされるため、通常は空になるはずですが、念のため
    const existingOcrContent = document.querySelectorAll('#fileContent img, #fileContent .ocr-status');
    existingOcrContent.forEach(el => fileContentDiv.prepend(el));
}

// --- ファイル名クリック時の内容表示 ---
function showDocumentContent(index) {
    const fileContentDiv = document.getElementById('fileContent');
    const doc = persistentDocuments[index];
    if (doc) {
        // 選択されたファイルの全文
        // 表示
        fileContentDiv.innerHTML = `<h3>${isEn ? 'Selected File' : '選択中のファイル'}: ${doc.name}</h3><pre>${doc.content}</pre>`;
    }
}

// --- コンテキストメニュー (右クリック) 関連 ---
function createContextMenu(e, index) {
    // 既存のメニューがあれば削除
    const existingMenu = document.getElementById('customContextMenu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.id = 'customContextMenu';
    menu.style.position = 'absolute';
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${e.pageY}px`;
    menu.style.backgroundColor = 'white';
    menu.style.border = '1px solid #ccc';
    menu.style.boxShadow = '2px 2px 5px rgba(0,0,0,0.2)';
    menu.style.zIndex = '1000';
    menu.style.padding = '5px 0';
    menu.style.minWidth = '120px';
    menu.style.borderRadius = '4px';

    const createMenuItem = (text, onClick, color = 'black') => {
        const item = document.createElement('div');
        item.textContent = text;
        item.style.padding = '8px 12px';
        item.style.cursor = 'pointer';
        item.style.fontSize = '14px';
        item.style.color = color;
        item.onmouseover = () => item.style.backgroundColor = '#f0f0f0';
        item.onmouseout = () => item.style.backgroundColor = 'white';
        item.onclick = (ev) => {
            ev.stopPropagation();
            menu.remove();
            onClick();
        };
        return item;
    };

    menu.appendChild(createMenuItem(isEn ? 'Rename' : '名前を変更', () => renameDocument(index)));
    menu.appendChild(createMenuItem(isEn ? 'Delete' : '削除', () => deleteDocument(index), 'red'));

    document.body.appendChild(menu);

    const closeMenu = (event) => {
        if (!menu.contains(event.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function renameDocument(index) {
    const doc = persistentDocuments[index];
    
    // カスタムダイアログを作成 (promptでは選択範囲の制御ができないため)
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
    overlay.style.zIndex = '2000';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';

    const dialog = document.createElement('div');
    dialog.style.backgroundColor = 'white';
    dialog.style.padding = '20px';
    dialog.style.borderRadius = '8px';
    dialog.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
    dialog.style.minWidth = '300px';

    const title = document.createElement('h3');
    title.textContent = isEn ? 'Rename' : '名前を変更';
    title.style.marginTop = '0';
    title.style.marginBottom = '15px';
    
    const input = document.createElement('input');
    input.type = 'text';
    input.value = doc.name;
    input.style.width = '100%';
    input.style.padding = '8px';
    input.style.marginBottom = '20px';
    input.style.boxSizing = 'border-box';
    input.style.fontSize = '16px';

    const btnContainer = document.createElement('div');
    btnContainer.style.display = 'flex';
    btnContainer.style.justifyContent = 'flex-end';
    btnContainer.style.gap = '10px';

    const closeDialog = () => overlay.remove();

    const save = () => {
        const newName = input.value.trim();
        if (newName && newName !== "" && newName !== doc.name) {
            doc.name = newName;
            saveDocuments();
            updateFileListDisplay();
        }
        closeDialog();
    };

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = isEn ? 'Cancel' : 'キャンセル';
    cancelBtn.style.padding = '6px 12px';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.onclick = closeDialog;
    
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.padding = '6px 12px';
    okBtn.style.cursor = 'pointer';
    okBtn.onclick = save;

    btnContainer.appendChild(cancelBtn);
    btnContainer.appendChild(okBtn);

    dialog.appendChild(title);
    dialog.appendChild(input);
    dialog.appendChild(btnContainer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 入力欄にフォーカスし、拡張子を除いた部分を選択状態にする
    input.focus();
    const lastDotIndex = doc.name.lastIndexOf('.');
    if (lastDotIndex > 0) {
        input.setSelectionRange(0, lastDotIndex);
    } else {
        input.select();
    }

    // Enterキーで保存、Escapeでキャンセル
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') closeDialog();
    });
}

function deleteDocument(index) {
    const doc = persistentDocuments[index];
    const msg = isEn ? `Are you sure you want to delete "${doc.name}"?` : `本当に「${doc.name}」を削除しますか？`;
    if (confirm(msg)) {
        persistentDocuments.splice(index, 1);
        saveDocuments();
        updateFileListDisplay();
    }
}

// --- File System Access API 関連 ---
let directoryHandle = null;
let syncInterval = null;

// ローカルフォルダと同期する関数
async function syncLocalFolder() {
    if (!('showDirectoryPicker' in window)) {
        alert(isEn ? 'Your browser does not support File System Access API.' : 'お使いのブラウザはローカルフォルダ同期(File System Access API)をサポートしていません。PC版ChromeやEdgeをご利用ください。');
        return;
    }

    // 既存の同期を停止
    if (syncInterval) clearInterval(syncInterval);

    try {
        // ユーザーにフォルダを選択させる
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        directoryHandle = handle;
        
        const msg = isEn 
            ? `Start syncing with folder "${handle.name}"?\nFiles in this folder will be automatically synced.`
            : `フォルダ「${handle.name}」と同期を開始しますか？\nこのフォルダ内のファイルは自動的に同期（追加・更新）されます。`;

        if (confirm(msg)) {
            // 初回読み込み (UI表示あり)
            await loadFilesFromDirectory(false);
            // 自動同期タイマーを開始 (10秒ごとにチェック)
            syncInterval = setInterval(() => loadFilesFromDirectory(true), 10000);
        }

    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('フォルダ選択中にエラーが発生しました:', err);
            alert(isEn ? 'Error selecting folder.' : 'フォルダ選択中にエラーが発生しました。');
        }
    }
}

// 選択されたディレクトリからファイルを読み込む関数
async function loadFilesFromDirectory(isSilent = false) {
    if (!directoryHandle) return;

    const fileContentDiv = document.getElementById('fileContent');
    
    // サイレントモードでない場合のみローディング表示
    if (!isSilent) {
        fileContentDiv.innerHTML = isEn ? '<h3>Syncing files...</h3><div class="spinner"></div>' : '<h3>同期フォルダからファイルを読み込み中...</h3><div class="spinner"></div>';
    }

    try {
        const scannedDocs = [];

        // 再帰的にファイルを読み込むヘルパー関数
        async function readDirectoryRecursive(dirHandle, pathPrefix = '') {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file') {
                    if (/\.(txt|md|log|py|js|json|c|cpp|h|java|html|css|csv|rb|go|rs|php)$/i.test(entry.name)) {
                        try {
                            const file = await entry.getFile();
                            const content = await file.text();
                            // パスを含めた名前で保存 (例: subfolder/file.txt)
                            scannedDocs.push({ name: pathPrefix + entry.name, content: content });
                        } catch (e) {
                            console.warn(`Skipped file: ${entry.name}`, e);
                        }
                    }
                } else if (entry.kind === 'directory') {
                    await readDirectoryRecursive(entry, pathPrefix + entry.name + '/');
                }
            }
        }

        await readDirectoryRecursive(directoryHandle);

        if (scannedDocs.length === 0) {
            if (!isSilent) {
                alert(isEn ? "No text files found." : "読み込み可能なテキストファイルが見つかりませんでした。");
                updateFileListDisplay();
            }
            return;
        }

        let changesMade = false;
        let addedCount = 0;
        let updatedCount = 0;

        // マージロジック: 既存の文書を更新または新規追加
        for (const doc of scannedDocs) {
            const existingIndex = persistentDocuments.findIndex(d => d.name === doc.name);
            if (existingIndex !== -1) {
                // 内容が変更されている場合のみ更新
                if (persistentDocuments[existingIndex].content !== doc.content) {
                    persistentDocuments[existingIndex].content = doc.content;
                    changesMade = true;
                    updatedCount++;
                }
            } else {
                // 新規追加
                persistentDocuments.push(doc);
                changesMade = true;
                addedCount++;
            }
        }

        if (changesMade) {
            saveDocuments(); // LocalStorageに保存
            updateFileListDisplay(); // ファイル一覧を更新
            
            if (!isSilent) {
                alert(isEn ? `Synced: ${addedCount} added, ${updatedCount} updated.` : `フォルダ「${directoryHandle.name}」から ${addedCount} 件追加、${updatedCount} 件更新しました。`);
            } else {
                console.log(`Auto-sync: Added ${addedCount}, Updated ${updatedCount}`);
            }
        } else {
            if (!isSilent) {
                alert(isEn ? "Files are up to date." : "ファイルの内容は最新です。");
                updateFileListDisplay(); // 表示を復元
            }
        }

    } catch (err) {
        console.error('フォルダからのファイル読み込み中にエラーが発生しました:', err);
        if (!isSilent) {
            alert(isEn ? 'Error syncing files.' : 'フォルダからのファイル読み込み中にエラーが発生しました。');
            updateFileListDisplay(); // 表示を復元
        }
    }
}

// --- Tesseract.js OCR処理関数 (改善版: 詳細ステータス表示付き) ---
async function runOcrOnImage(base64Image, statusElement) {
    try {
        if (!worker) {
            statusElement.innerHTML = '<div class="spinner"></div> OCRワーカーを初期化中... (1/3 初回時間がかかります)';
            statusElement.style.color = 'orange';

            // Tesseract Workerの作成 (ロガーを設定)
            worker = await Tesseract.createWorker({
                logger: m => {
                    const progress = Math.round(m.progress * 100);
                    let statusText = '';
                    
                    // 処理の進捗に合わせて詳細なメッセージを表示
                    if (m.status === 'downloading tesseract core') {
                        statusText = `OCRエンジンをダウンロード中... (${progress}%)`;
                    } else if (m.status === 'loading tesseract core') {
                        statusText = `OCRエンジンをロード中... (${progress}%)`;
                    } else if (m.status === 'initializing api') {
                        statusText = `APIを初期化中... (${progress}%)`;
                    } else if (m.status === 'loading language traineddata') {
                           statusText = `言語データ(jpn+eng)をロード中... (${progress}%)`;
                    } else if (m.status === 'initializing api') {
                           statusText = `OCR APIを初期化中... (${progress}%)`;
                    } else if (m.status === 'recognizing text' && m.progress > 0) {
                           // テキスト認識中の進捗
                           statusText = `テキスト認識中: ${progress}%`;
                           statusElement.style.color = 'blue'; 
                    } else if (m.status) {
                           statusText = `OCRステータス: ${m.status}`;
                    } else {
                        return; // 不要なログはスキップ
                    }
                    
                    statusElement.innerHTML = `<div class="spinner"></div> ${statusText}`;
                },
            });
            
            // 言語ロードと初期化フェーズ
            statusElement.innerHTML = '<div class="spinner"></div> 言語データをロード中 (jpn+eng)... (2/3)';
            await worker.loadLanguage('jpn+eng'); 
            
            statusElement.innerHTML = '<div class="spinner"></div> OCRワーカーを初期化中... (3/3)';
            await worker.initialize('jpn+eng');
            
            statusElement.textContent = 'OCRワーカーの初期化完了。テキスト認識中...';
        }

        // 認識フェーズ
        const { data: { text } } = await worker.recognize(base64Image);
        return text;
    } catch (error) {
        console.error("Tesseract OCR Error:", error);
        throw new Error(`OCR処理中に致命的なエラーが発生しました: ${error.message}`);
    }
}


// --- ファイル入力のイベントリスナー ---
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', function () {
            const files = this.files;
            if (files.length === 0) return;
            
            // ファイルの内容を読み込み、persistentDocuments に追加
            const fileReads = Array.from(files).map(file => {
                return new Promise((resolve, reject) => {
                    if (file.size > 10 * 1024 * 1024) { // 10MB以上はスキップ
                        alert(`ファイル「${file.name}」はサイズ制限（10MB）を超えているためスキップされました。`);
                        return resolve();
                    }
                    const reader = new FileReader();
                    reader.onload = function (e) {
                        const newDoc = { name: file.name, content: e.target.result };
                        persistentDocuments.push(newDoc);
                        resolve();
                    };
                    reader.onerror = reject;
                    reader.readAsText(file);
                });
            });

            Promise.all(fileReads.filter(p => p !== null))
                .then(() => {
                    saveDocuments();
                    updateFileListDisplay();
                    alert(`新しいファイル ${persistentDocuments.length - (persistentDocuments.length - files.length)} 件をRAGソースに追加しました。`);
                })
                .catch(error => {
                    alert('ファイルの読み込み中にエラーが発生しました。');
                    console.error("File reading error:", error);
                });
            
            this.value = ''; // 連続アップロードのためにinputをクリア
        });
    }
});

// --- 貼り付け画像処理のイベントリスナー (OCR連携ロジック) ---
async function handlePaste(e) {
    const items = e.clipboardData.items;
    let imageFound = false;
    
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault(); 
            const blob = item.getAsFile();
            const reader = new FileReader();
            imageFound = true;
            
            // OCR結果は一旦クリア
            ocrDocuments = [];
            clearOcrDisplay();

            // 処理中メッセージ表示要素 (ステータス表示用)
            const processingMessage = document.createElement('p');
            processingMessage.className = 'ocr-status';
            processingMessage.textContent = '画像を貼り付けました。OCR処理を開始しています...';
            const fileContentDiv = document.getElementById('fileContent');
            fileContentDiv.prepend(processingMessage);

            reader.onload = async function (event) {
                const base64Image = event.target.result;
                const imageName = `一時貼付画像_${Date.now()}`;
                
                // 画像をfileContentエリアに表示
                const img = document.createElement('img');
                img.src = base64Image;
                img.alt = imageName;
                fileContentDiv.prepend(img);
                
                try {
                    // 1. OCR処理を実行 (詳細ステータスはprocessingMessageで更新される)
                    const ocrText = await runOcrOnImage(base64Image, processingMessage);
                    
                    // 2. OCR結果を一時文書として保持
                    const fullOcrContent = ocrText.trim(); 
                    if (fullOcrContent) {
                        ocrDocuments.push({
                            name: imageName,
                            content: fullOcrContent
                        });
                    }
                    
                    // 3. ステータス更新（最終メッセージ）
                    if (fullOcrContent) {
                        processingMessage.innerHTML = `✅ OCR処理完了: <strong>${imageName}</strong> のテキストがRAG対象に追加されました (一時保存)。<br>「保存」ボタンで永続化できます。`;
                        processingMessage.style.color = 'green';
                    } else {
                        processingMessage.innerHTML = `⚠️ OCR処理完了: テキストを検出できませんでした。画像を削除するには「貼付けテキストを永続ファイルとして保存」するか、別の画像を貼り付けてください。`;
                        processingMessage.style.color = 'brown';
                    }
                    
                } catch (error) {
                    processingMessage.innerHTML = `❌ OCR処理中にエラーが発生しました: ${error.message}`;
                    processingMessage.style.color = 'red';
                    console.error("OCR Error:", error);
                } finally {
                    document.getElementById('pasteArea').value = ''; // 貼り付けエリアをクリア
                }
            };
            reader.readAsDataURL(blob);
            break;
        }
    }
    
    // 画像貼り付けではない場合は、テキスト貼り付けとして処理は継続される（pasteAreaに入る）
}

// --- OCR/貼付テキストのファイル保存と永続化 ---

function saveOcrTextAsFile() {
    const allTextDocuments = [...ocrDocuments];
    const pasteAreaContent = document.getElementById('pasteArea').value.trim();
    
    let contentToSave = '';
    
    // 1. OCRで抽出された一時文書を統合
    allTextDocuments.forEach(doc => {
        contentToSave += `--- ファイル名: ${doc.name} ---\n`;
        contentToSave += doc.content + '\n\n';
    });
    
    // 2. 貼り付けエリアのテキストを統合
    if (pasteAreaContent) {
           contentToSave += `--- ファイル名: 貼付テキスト ---\n`;
           contentToSave += pasteAreaContent + '\n\n';
    }

    if (!contentToSave.trim()) {
        alert("永続化するテキスト（OCR結果または貼付エリアの内容）がありません。");
        return;
    }

    // 3. LocalStorageに永続化 (ファイル名を付けて persistentDocuments に追加)
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const filename = `plower_memo_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
    
    persistentDocuments.push({ name: filename, content: contentToSave });
    saveDocuments();
    
    // 4. ローカルPCにダウンロード (エクスプローラへの保存)
    const blob = new Blob([contentToSave], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // 5. UIのクリーンアップ
    alert(`OCR/貼付テキストを「${filename}」として保存し、RAGソースとして永続化しました。`);
    
    document.getElementById('pasteArea').value = '';
    ocrDocuments = [];
    clearOcrDisplay(); // 重要な変更点：保存が完了したら画像とステータスをクリア
    updateFileListDisplay(); // ファイルリストを更新
}


// --- LLMリクエスト共通関数 (翻訳・回答生成で再利用) ---
async function performLlmRequest(modelSelect, prompt, apiKey, onChunk = null) {
    let result = '';
    let endpoint = '';
    let bodyData = {};
    let isStreaming = false;
    
    const isGeminiCloudModel = modelSelect.toLowerCase().startsWith('gemini');
    const isSarasinaModel = modelSelect.toLowerCase().includes('sarasina');
    
    if (isGeminiCloudModel) {
        // --- Gemini Cloud Model ---
        if (!apiKey) throw new Error("Gemini API Key is required.");

        let candidates = [];
        if (modelSelect.includes('flash')) {
            candidates = ['gemini-2.5-flash', 'gemini-flash-lite', 'gemini-2.0-flash-exp', 'gemini-1.5-flash', 'gemini-1.5-flash-002', 'gemini-1.5-flash-001'];
        } else {
            candidates = ['gemini-2.5-pro', 'gemini-2.0-pro-exp-02-05', 'gemini-1.5-pro', 'gemini-1.5-pro-002', 'gemini-1.5-pro-001'];
        }

        let success = false;
        let lastError = null;

        for (const modelVersion of candidates) {
            try {
                console.log(`Trying Gemini model: ${modelVersion}`);
                const currentEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelVersion}:generateContent?key=${apiKey}`;
                const currentBody = {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.1 }
                };

                const response = await fetch(currentEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentBody)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status === 404 || response.status === 503) {
                        lastError = new Error(`Gemini API Error (${response.status}): ${errorText}`);
                        continue;
                    }
                    if (response.status === 400 || response.status === 403) {
                        localStorage.removeItem('plowerGeminiApiKey');
                        throw new Error(`Gemini API Auth Error (${response.status}): ${errorText}`);
                    }
                    throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
                }

                const json = await response.json();
                if (json.candidates && json.candidates[0].content) {
                    result = json.candidates[0].content.parts.map(p => p.text).join('');
                    success = true;
                    break; 
                } else {
                    throw new Error(`Unexpected response format from ${modelVersion}`);
                }
            } catch (e) {
                lastError = e;
                console.error(`Error with model ${modelVersion}:`, e);
            }
        }

        if (!success) throw lastError || new Error('All Gemini candidates failed.');
        if (onChunk) onChunk(result);
        return result;

    } else if (isSarasinaModel) {
        // --- Sarasina Model ---
        endpoint = 'http://localhost:8001/api/sarasina';
        bodyData = { model: modelSelect, prompt: prompt, temperature: 0.1 };
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
        
        if (!response.ok) throw new Error(`Sarasina Error: ${response.statusText}`);
        const json = await response.json();
        result = json.response || json.detail || "";
        if (onChunk) onChunk(result);
        return result;

    } else {
        // --- Ollama Model ---
        let ollamaBaseUrl = localStorage.getItem('plowerOllamaEndpoint') || 'http://localhost:11434';
        if (ollamaBaseUrl.endsWith('/')) ollamaBaseUrl = ollamaBaseUrl.slice(0, -1);
        endpoint = ollamaBaseUrl.endsWith('/api/generate') ? ollamaBaseUrl : `${ollamaBaseUrl}/api/generate`;

        bodyData = {
            model: modelSelect, 
            prompt: prompt,
            stream: true,
            options: { temperature: 0.1, num_ctx: 8192 }
        };

        return await fetchOllamaStream(endpoint, bodyData, onChunk);
    }
}

// Ollamaストリーミング処理のヘルパー
async function fetchOllamaStream(endpoint, bodyData, onChunk) {
    let result = '';
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyData)
    });

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
         throw new Error("Server returned HTML. Check URL or Space status.");
    }

    if (!response.ok) {
        if (response.status === 404) throw new Error(`Model '${bodyData.model}' not found.`);
        if (response.status === 403) throw new Error(`Access Forbidden (403). Check OLLAMA_ORIGINS.`);
        throw new Error(`Ollama Error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) throw new Error("No response body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        chunk.trim().split('\n').forEach(line => {
            if (line) {
                try {
                    const json = JSON.parse(line);
                    if (json.response) {
                        result += json.response;
                        if (onChunk) onChunk(result);
                    }
                } catch (e) {}
            }
        });
    }
    return result;
}

// --- モデル送信ロジック ---
async function sendToModel() {
    const userInputElement = document.getElementById('userInput');
    const userInput = userInputElement.value.trim();
    const pasteAreaContent = document.getElementById('pasteArea').value.trim();
    const chatLog = document.getElementById('chatLog');
    const sendButton = document.getElementById('sendButton');
    const modelSelect = document.getElementById('modelSelect').value;
    const apiKey = document.getElementById('geminiApiKey').value.trim();

    if (!userInput) {
        alert(isEn ? "Please enter a question." : "質問を入力してください。");
        return;
    }

    sendButton.disabled = true;
    sendButton.textContent = isEn ? 'Sending...' : '送信中...';
    chatLog.innerHTML += `<p><strong>${isEn ? 'Question' : '質問'}:</strong> ${userInput}</p>`;
    const responseParagraph = document.createElement('p');
    responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> (${isEn ? 'Processing...' : '処理中...'})`;
    chatLog.appendChild(responseParagraph);

    // 全てのRAGソースを統合
    let allDocuments = [...persistentDocuments, ...ocrDocuments];
    if (pasteAreaContent) {
        // 貼り付けエリアのテキストは一時文書として扱う
        allDocuments.push({ name: '貼付けテキスト(一時)', content: pasteAreaContent });
    }
    
    // --- フロントエンドでの検索処理を廃止 ---
    // ユーザーの指示に基づき、ローカルでの検索や翻訳を行わず、全ての文書をコンテキストとしてLLMに渡す。
    console.log(`全ての文書(${allDocuments.length}件)をコンテキストとして使用します。`);
    const context = allDocuments.map(doc => `【${doc.name}】\n${doc.content}`).join('\n\n').slice(0, 10000); // 10000文字に制限

    // プロンプトの生成: 質問と同じ言語で回答させるための指示を明確化。
    // ブラウザの言語設定(isEn)に依存せず、常に同じ構造のプロンプトを渡すことで、モデルの動作を安定させます。
    const prompt = `You are a helpful assistant. Your task is to answer the user's question based *only* on the provided [Reference Documents].

IMPORTANT INSTRUCTIONS:
1.  **Answer in the same language as the user's [Question].** (e.g., if the question is in Japanese, your answer MUST be in Japanese).
2.  Base your answer strictly on the information within the [Reference Documents]. Do not use any external knowledge.
3.  **Language Handling:** The documents may be in a different language than the question. You must translate and interpret the documents to answer the question accurately.
4.  If the answer cannot be found in the [Reference Documents], you MUST state that the information is not available, in the same language as the question.

[Reference Documents]
${context}

[Question]
${userInput}`;

    // --- 回答生成 ---
    try {
        // 共通関数を使ってリクエスト
        const finalResult = await performLlmRequest(modelSelect, prompt, apiKey, (chunkText) => {
            // ストリーミング更新
            responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ${chunkText.replace(/\n/g, '<br>')}`;
            chatLog.scrollTop = chatLog.scrollHeight;
        });

        // 最終結果の表示 (非ストリーミングモデル用)
        responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ${finalResult.replace(/\n/g, '<br>')}`;
        userInputElement.value = ''; // 質問欄をクリア

    } catch (error) {
        let errorMsg = error.message;
        // HTTPS環境からHTTP(ローカル)へ接続しようとして失敗した場合のヒントを追加
        if (window.location.protocol === 'https:' && error.message.includes('Failed to fetch')) {
            errorMsg += isEn 
                ? "<br>⚠️ Mixed Content Error: Cannot connect to HTTP (Localhost) from HTTPS app. Please use an HTTPS endpoint (e.g., Hugging Face Space) or use a tunneling tool like ngrok."
                : "<br>⚠️ 混在コンテンツエラー: HTTPSでホストされたアプリから、HTTPのローカルサーバー(Ollama)には直接接続できません。<br>Hugging Face SpaceなどのHTTPSエンドポイントを使用するか、ngrok等でローカルサーバーをHTTPS化してください。";
        }
        responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ❌ ${isEn ? 'Error occurred' : 'エラーが発生しました'}: ${errorMsg}`;
        console.error("Model request error:", error);
    } finally {
        sendButton.disabled = false;
        sendButton.textContent = isEn ? 'Send' : '送信';
        // 最新のチャットが見えるようにスクロール
        chatLog.scrollTop = chatLog.scrollHeight;
    }
}

// --- 初期化とイベントリスナー設定 ---
document.addEventListener('DOMContentLoaded', () => {
    loadDocuments(); 
    document.getElementById('sendButton').addEventListener('click', sendToModel);
    document.getElementById('resetDocsButton').addEventListener('click', resetDocuments);
    document.getElementById('saveOcrButton').addEventListener('click', saveOcrTextAsFile);
    document.getElementById('syncFolderButton').addEventListener('click', syncLocalFolder);
    
    // DOMロード後にイベントリスナーを登録 (安全策)
    const pasteArea = document.getElementById('pasteArea');
    if (pasteArea) pasteArea.addEventListener('paste', handlePaste);

    // APIキーのロードと保存処理
    const savedKey = localStorage.getItem('plowerGeminiApiKey');
    if (savedKey) {
        document.getElementById('geminiApiKey').value = savedKey;
    }
    
    const saveKeyBtn = document.getElementById('saveKeyButton');
    saveKeyBtn.addEventListener('click', () => {
        const key = document.getElementById('geminiApiKey').value.trim();
        if (key) {
            localStorage.setItem('plowerGeminiApiKey', key);
            alert(isEn ? 'API Key saved to browser.' : 'APIキーをブラウザに保存しました。次回から自動入力されます。');
        } else {
            alert(isEn ? 'API Key is empty. Use "Delete Key" button to remove it.' : 'APIキーが空です。削除する場合は「削除」ボタンを使用してください。');
        }
    });

    // 削除ボタンを動的に追加
    const deleteKeyBtn = document.createElement('button');
    deleteKeyBtn.textContent = isEn ? 'Delete Key' : 'キー削除';
    deleteKeyBtn.style.marginLeft = '5px';
    deleteKeyBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerGeminiApiKey');
        document.getElementById('geminiApiKey').value = '';
        alert(isEn ? 'Saved API Key deleted.' : '保存されたAPIキーを削除しました。');
    });
    saveKeyBtn.parentNode.insertBefore(deleteKeyBtn, saveKeyBtn.nextSibling);
    
    // --- Ollama URL設定の初期化とイベントリスナー ---
    const ollamaInput = document.getElementById('ollamaUrlInput');
    ollamaInput.value = localStorage.getItem('plowerOllamaEndpoint') || 'http://localhost:11434';

    const saveOllamaBtn = document.getElementById('saveOllamaUrlButton');
    saveOllamaBtn.addEventListener('click', () => {
        let url = ollamaInput.value.trim();
        if (!url) url = 'http://localhost:11434';
        let finalMessage = isEn ? 'Ollama URL saved.' : 'OllamaのURL設定を保存しました。';
        
        // Hugging Face SpacesのWeb URLが入力された場合、Direct URLに自動変換する
        // 例: https://huggingface.co/spaces/username/spacename -> https://username-spacename.hf.space
        const hfMatch = url.match(/^https?:\/\/huggingface\.co\/spaces\/([^\/]+)\/([^\/]+)\/?$/);
        if (hfMatch) {
            const username = hfMatch[1].toLowerCase();
            const spacename = hfMatch[2].toLowerCase();
            url = `https://${username}-${spacename}.hf.space`;
            ollamaInput.value = url; // 入力欄も更新
            finalMessage = isEn ? 'Converted Hugging Face Space URL to Direct URL format and saved.' : 'Hugging Face SpaceのWeb URLを検出し、API用のDirect URL形式に自動変換して保存しました。';
        }
        
        localStorage.setItem('plowerOllamaEndpoint', url);
        alert(finalMessage);
    });

    // Ollama URL削除ボタンを動的に追加
    const deleteOllamaBtn = document.createElement('button');
    deleteOllamaBtn.textContent = isEn ? 'Delete URL' : 'URL削除';
    deleteOllamaBtn.style.marginLeft = '5px';
    deleteOllamaBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerOllamaEndpoint');
        ollamaInput.value = 'http://localhost:11434';
        alert(isEn ? 'Saved Ollama URL deleted (Reset to default).' : '保存されたOllama URLを削除しました（デフォルトに戻りました）。');
    });
    saveOllamaBtn.parentNode.insertBefore(deleteOllamaBtn, saveOllamaBtn.nextSibling);

    // Enterキーでの送信機能
    document.getElementById('userInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendToModel();
        }
    });
});