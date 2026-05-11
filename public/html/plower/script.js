// 永続化された文書を格納 (LocalStorageからロード)
let persistentDocuments = []; 

// 貼り付けられた画像データの配列 [{id, data, name}]
let pastedImages = [];

// 言語設定の判定 (日本語以外なら英語モード)
const isEn = !navigator.language.startsWith('ja');

const PREVIEW_MAX_DOCS = 5; // コンテンツ表示エリアに表示する最大ファイル数

// --- IndexedDB 初期化 ---
const dbName = "PlowerDB";
const storeName = "documents";

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            db.createObjectStore(storeName);
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// --- LocalStorageからの文書ロードとファイル一覧の表示 ---
async function loadDocuments() {
    try {
        // 移行期対応: LocalStorageにデータがあれば取得して移行
        const legacyDocs = localStorage.getItem('plowerRAGDocs');
        if (legacyDocs) {
            persistentDocuments = JSON.parse(legacyDocs);
            await saveDocuments(); // 新しいDBに保存
            localStorage.removeItem('plowerRAGDocs'); // 移行完了後削除
        } else {
            const db = await openDB();
            const tx = db.transaction(storeName, "readonly");
            const store = tx.objectStore(storeName);
            const request = store.get("plowerRAGDocs");
            persistentDocuments = await new Promise((resolve) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => resolve([]);
            });

            // ディレクトリハンドルの復元
            const dirReq = store.get("plowerDirHandle");
            directoryHandle = await new Promise((resolve) => {
                dirReq.onsuccess = () => resolve(dirReq.result || null);
                dirReq.onerror = () => resolve(null);
            });
            
            if (directoryHandle) {
                // ハンドルがあれば自動同期タイマーを再開（権限は後でクリック時に要求）
                syncInterval = setInterval(() => loadFilesFromDirectory(true), 10000);
            }
        }
        updateFileListDisplay();
    } catch (e) {
        console.error("Failed to load documents:", e);
        persistentDocuments = [];
    }
}

// --- LocalStorageへの文書保存 ---
async function saveDocuments() {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            // .txtファイルのみ内容を保存し、それ以外は名前のみ保持してIndexedDBの肥大化を防ぐ
            const docsToPersist = persistentDocuments.map(doc => ({
                name: doc.name,
                content: doc.name.toLowerCase().endsWith('.txt') ? doc.content : ""
            }));

            const tx = db.transaction(storeName, "readwrite");
            const store = tx.objectStore(storeName);

            // 文書リストの保存
            store.put(docsToPersist, "plowerRAGDocs");
            
            // フォルダハンドルの保存（シリアライズ可能なブラウザのみ）
            if (directoryHandle) {
                try {
                    store.put(directoryHandle, "plowerDirHandle");
                } catch (e) {
                    console.warn("Failed to serialize directoryHandle to IDB:", e);
                }
            }

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error("Failed to save documents:", e);
    }
}

// ヘルパー: Blobを同期フォルダに書き込む
async function saveBlobToDirectory(blob, filename) {
    if (!directoryHandle) return false;
    try {
        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
    } catch (e) {
        console.error("Failed to auto-save to directory:", e);
        return false;
    }
}

// LocalStorageをリセットする関数
async function resetDocuments() {
    const msgConfirm = isEn 
        ? "Are you sure you want to delete all RAG source documents?\n(This cannot be undone. All uploaded files will be cleared from LocalStorage.)"
        : "本当にRAGソース文書を全て削除しますか？\n（この操作は元に戻せません。アップロードされたファイルがLocalStorageから全て消去されます。）";
    if (confirm(msgConfirm)) {
        try {
            const db = await openDB();
            const tx = db.transaction(storeName, "readwrite");
            tx.objectStore(storeName).clear();

            persistentDocuments = [];
            document.getElementById('pasteArea').value = '';

            // 同期設定のクリア
            directoryHandle = null;
            const store = tx.objectStore(storeName);
            store.delete("plowerDirHandle");
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
        li.onclick = async (e) => {
            // 選択状態のUIフィードバック（任意）
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
            const isImage = doc.name.match(/\.(png|jpg|jpeg|webp|gif)$/i) || doc.content.startsWith('data:image/');
            initialContent += `<p><strong>【${doc.name}】</strong></p>`;
            if (isImage) {
                // 内容が空（再読み込み後かつ同期前）でも画像枠を表示
                const imgSrc = doc.content || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
                initialContent += `<div style="margin-bottom:10px;"><img src="${imgSrc}" alt="${doc.name}" style="max-width:200px; max-height:150px; border:1px solid #ccc; border-radius:4px; background: #eee; opacity: ${doc.content ? 1 : 0.5};"></div>`;
            } else {
                // テキストの場合は内容の一部を表示
                initialContent += `<pre>--- ${isEn ? 'File Name' : 'ファイル名'}: ${doc.name} ---\n${doc.content.slice(0, 300)}${doc.content.length > 300 ? '...' : ''}</pre>\n`;
            }
        });
    } else {
        initialContent += isEn ? '<p>No RAG source documents available.</p>' : '<p>現在RAGのソースとなる文書はありません。</p>';
    }
    fileContentDiv.innerHTML = initialContent;
}

// --- パス文字列からFileHandleを取得するヘルパー ---
async function getFileHandleByPath(path) {
    if (!directoryHandle) return null;
    const parts = path.split('/');
    let currentHandle = directoryHandle;
    
    try {
        // 最後の要素以外はディレクトリとして辿る
        for (let i = 0; i < parts.length - 1; i++) {
            currentHandle = await currentHandle.getDirectoryHandle(parts[i]);
        }
        // 最後の要素をファイルとして取得
        return await currentHandle.getFileHandle(parts[parts.length - 1]);
    } catch (e) {
        console.warn(`File not found in local sync folder: ${path}`);
        return null;
    }
}

// --- ファイル名クリック時の内容表示 ---
async function showDocumentContent(index) {
    const fileContentDiv = document.getElementById('fileContent');
    const doc = persistentDocuments[index];
    if (!doc) return;

    let displayContent = doc.content;
    let isImage = doc.name.match(/\.(png|jpg|jpeg|webp|gif)$/i) || doc.content.startsWith('data:image/');

    // 1. 同期フォルダの権限確認（API対応ブラウザのみ）
    let hasDirectoryPermission = false;
    if (directoryHandle && window.showDirectoryPicker) {
        const options = { mode: 'readwrite' };
        if ((await directoryHandle.queryPermission(options)) === 'granted') {
            hasDirectoryPermission = true;
        }
    }

    // 2. 同期フォルダが有効なら実体（最新化）を試みる
    if (hasDirectoryPermission) {
        const fileHandle = await getFileHandleByPath(doc.name);
        
        if (!fileHandle) {
            // クリック時に実体が無かったら、RAGソース一覧から削除
            console.warn(`File missing locally: ${doc.name}`);
            persistentDocuments.splice(index, 1); 
            await saveDocuments();
            updateFileListDisplay();
            fileContentDiv.innerHTML = `<p style="color:red;">${isEn ? 'File not found locally.' : 'ローカルにファイルが見つかりません。'}</p>`;
            return; // 処理中断
        }

        // 実体がある場合、最新の内容を読み込む（IndexedDBの古いキャッシュではなく実体優先）
        try {
            const file = await fileHandle.getFile();
            if (isImage) {
                displayContent = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (e) => {
                        // メモリ上のデータを更新して表示を安定させる
                        doc.content = e.target.result;
                        resolve(e.target.result);
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });
            } else if (doc.name.toLowerCase().endsWith('.txt')) {
                displayContent = await file.text();
                doc.content = displayContent; // メモリ更新
            } else {
                displayContent = isEn ? "(Non-text file. Name only.)" : "(テキスト以外のファイル。名前のみ登録されています。)";
            }
        } catch (e) {
            console.error("Failed to read file entity:", e);
        }
    }

    // 3. 実体が読み込めない（再読み込み後やモバイル）場合の修復UI
    if (!displayContent || (isImage && !displayContent.startsWith('data:image/'))) {
        let fallbackHtml = `<h3>${doc.name}</h3>`;
        
        if (window.showDirectoryPicker) {
            // PC環境（API対応）
            fallbackHtml += `<p style="color:red;">${isEn ? "Sync lost. Please re-link folder or re-upload file." : "ローカルとの同期が切れています。フォルダを再選択するか、ファイルを再指定してください。"}</p>`;
            fallbackHtml += `<button onclick="syncLocalFolder()" style="padding:10px; cursor:pointer; width:100%; margin-bottom:10px;">${isEn ? 'Re-link Sync Folder' : '同期フォルダを再選択'}</button>`;
        } else {
            // スマホ環境（API非対応）
            fallbackHtml += `<p style="color:orange;">${isEn ? "Content missing. Please re-upload this file to view." : "内容が保持されていません。表示するにはファイルを再アップロードしてください。"}</p>`;
        }
        
        fallbackHtml += `<p>${isEn ? 'Manually re-upload this file:' : 'このファイルを手動で再読み込み:'}</p>`;
        fallbackHtml += `<input type="file" onchange="repairFileContent(${index}, this)" style="width:100%;">`;
        
        fileContentDiv.innerHTML = fallbackHtml;
        return;
    }

    // 4. 正常表示
    let contentHtml = `<h3>${isEn ? 'Selected File' : '選択中のファイル'}: ${doc.name}</h3>`;
    if (isImage && displayContent.startsWith('data:image/')) {
        contentHtml += `<img src="${displayContent}" style="max-width:100%; border:1px solid #ddd; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.1);">`;
    } else {
        contentHtml += `<pre>${displayContent || (isEn ? "No content available." : "内容がありません。")}</pre>`;
    }
    fileContentDiv.innerHTML = contentHtml;
}

// --- ファイルの手動再アップロードによる修復 ---
async function repairFileContent(index, input) {
    const file = input.files[0];
    if (!file) return;
    
    const doc = persistentDocuments[index];
    if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            doc.content = e.target.result;
            await saveDocuments();
            showDocumentContent(index);
        };
        reader.readAsDataURL(file);
    } else {
        doc.content = await file.text();
        await saveDocuments();
        showDocumentContent(index);
    }
}

// ディレクトリの権限を確認・要求するヘルパー
async function verifyDirectoryPermission(handle) {
    const options = { mode: 'readwrite' };
    if ((await handle.queryPermission(options)) === 'granted') return true;
    if ((await handle.requestPermission(options)) === 'granted') return true;
    return false;
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
    // 操作前に権限チェック
    if (directoryHandle) {
        verifyDirectoryPermission(directoryHandle).then(granted => {
            if (!granted) alert(isEn ? "Permission required to rename file." : "ファイル名を変更するには権限の許可が必要です。");
        });
    }

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

    const save = async () => {
        const newName = input.value.trim();
        if (newName && newName !== "" && newName !== doc.name) {
            const oldName = doc.name;
            
            // 同期フォルダがある場合、ローカルファイルもリネーム
            if (directoryHandle) {
                const fileHandle = await getFileHandleByPath(oldName);
                if (fileHandle) {
                    try {
                        // File System Access API の move メソッドを使用
                        await fileHandle.move(newName);
                    } catch (e) {
                        console.error("Failed to rename local file:", e);
                        alert(isEn ? "Failed to rename local file." : "ローカルファイルのリネームに失敗しました。");
                        return;
                    }
                }
            }

            doc.name = newName;
            await saveDocuments();
            updateFileListDisplay();
            alert(isEn ? "Renamed in list. Please manually rename the local file if sync failed." : "リスト上の名前を変更しました。同期に失敗した場合は、ローカルファイルも手動でリネームしてください。");
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
    setTimeout(() => {
        input.focus();
        const lastDotIndex = doc.name.lastIndexOf('.');
        if (lastDotIndex > 0) {
            // .png や .txt の手前までを選択
            input.setSelectionRange(0, lastDotIndex);
        } else {
            input.select();
        }
    }, 10);

    // Enterキーで保存、Escapeでキャンセル
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') closeDialog();
    });
}

async function deleteDocument(index) {
    const doc = persistentDocuments[index];
    const msg = isEn ? `Are you sure you want to delete "${doc.name}"?` : `本当に「${doc.name}」を削除しますか？`;
    if (confirm(msg)) {
        // 同期フォルダがある場合、ローカルからも削除
        if (directoryHandle) {
            try {
                const parts = doc.name.split('/');
                const fileName = parts.pop();
                let currentHandle = directoryHandle;
                
                // サブフォルダを辿る
                for (const part of parts) {
                    currentHandle = await currentHandle.getDirectoryHandle(part);
                }
                
                await currentHandle.removeEntry(fileName);
            } catch (e) {
                console.error("Failed to delete local file:", e);
                // ファイルが既にない場合はそのまま続行
            }
        }

        persistentDocuments.splice(index, 1);
        await saveDocuments();
        updateFileListDisplay();
    }
}

// --- File System Access API 関連 ---
let directoryHandle = null;
let syncInterval = null;

// ローカルフォルダと同期する関数
async function syncLocalFolder() {
    if (!('showDirectoryPicker' in window)) {
        return;
    }

    // 既存の同期を停止
    if (syncInterval) clearInterval(syncInterval);

    try {
        // ユーザーにフォルダを選択させる
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        directoryHandle = handle;
        await saveDocuments(); // ハンドルをIndexedDBに保存
        
        // 初回読み込み (UI表示あり)
        await loadFilesFromDirectory(false);
        // 自動同期タイマーを開始 (10秒ごとにチェック)
        if (syncInterval) clearInterval(syncInterval);
        syncInterval = setInterval(() => loadFilesFromDirectory(true), 10000);

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

    // 権限チェック
    const options = { mode: 'readwrite' };
    const currentPerm = await directoryHandle.queryPermission(options);

    // 自動同期(isSilent)時は、権限がない(prompt)なら何もしない（勝手にダイアログを出せないため）
    if (isSilent && currentPerm !== 'granted') {
        return;
    }

    // 手動クリック時は、権限がなければ要求する
    if (!isSilent && currentPerm !== 'granted') {
        const granted = await verifyDirectoryPermission(directoryHandle);
        if (!granted) return;
    }

    // 最終確認: 権限がないまま進むと scannedDocNames が空になり、全削除されるリスクがあるためガード
    if ((await directoryHandle.queryPermission(options)) !== 'granted') {
        return;
    }

    const fileContentDiv = document.getElementById('fileContent');
    
    // サイレントモードでない場合のみローディング表示
    if (!isSilent) {
        fileContentDiv.innerHTML = isEn ? '<h3>Syncing files...</h3><div class="spinner"></div>' : '<h3>同期フォルダからファイルを読み込み中...</h3><div class="spinner"></div>';
    }

    try {
        const scannedDocs = [];
        const scannedDocNames = new Set();

        // 再帰的にファイルを読み込むヘルパー関数
        async function readDirectoryRecursive(dirHandle, pathPrefix = '') {
            for await (const entry of dirHandle.values()) {
                const fullPath = pathPrefix + entry.name;
                scannedDocNames.add(fullPath); // 見つかったすべてのパスを記録

                if (entry.kind === 'file') {
                    const isTxt = fullPath.toLowerCase().endsWith('.txt');
                    const isImage = /\.(png|jpg|jpeg|webp|gif)$/i.test(entry.name);
                    
                    if (isTxt || isImage) {
                        try {
                            const file = await entry.getFile();
                            let content;
                            if (isTxt) {
                                content = await file.text();
                            } else {
                                // 画像はData URLとして読み込む
                                content = await new Promise((resolve, reject) => {
                                    const reader = new FileReader();
                                    reader.onload = (e) => resolve(e.target.result);
                                    reader.onerror = reject;
                                    reader.readAsDataURL(file);
                                });
                            }
                            scannedDocs.push({ name: fullPath, content: content });
                        } catch (e) {
                            console.warn(`Skipped file: ${fullPath}`, e);
                        }
                    } else {
                        // それ以外のファイルは名前のみリストに追加
                        scannedDocs.push({ name: fullPath, content: "" });
                    }
                } else if (entry.kind === 'directory') {
                    await readDirectoryRecursive(entry, fullPath + '/');
                }
            }
        }

        await readDirectoryRecursive(directoryHandle);

        let changesMade = false;
        let addedCount = 0;
        let updatedCount = 0;
        let removedCount = 0;

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

        // ローカルフォルダに存在しないファイルをIndexedDBから削除（同期）
        const originalLength = persistentDocuments.length;
        persistentDocuments = persistentDocuments.filter(doc => scannedDocNames.has(doc.name));
        removedCount = originalLength - persistentDocuments.length;
        if (removedCount > 0) changesMade = true;

        // 同期完了時は必ず保存（DBには名前のみ、メモリには内容を保持）
        await saveDocuments();
        updateFileListDisplay();

        if (changesMade && !isSilent) {
            alert(isEn 
                ? `Synced: ${addedCount} added, ${updatedCount} updated, ${removedCount} removed.` 
                : `同期完了: ${addedCount}件追加、${updatedCount}件更新、${removedCount}件削除されました。`);
        } else if (!isSilent) {
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

// --- ファイル入力のイベントリスナー ---
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', function () {
            const files = this.files;
            if (files.length === 0) return;
            
            Array.from(files).forEach(async file => {
                if (file.size > 10 * 1024 * 1024) {
                    alert(isEn ? `File "${file.name}" exceeds 10MB limit.` : `ファイル「${file.name}」はサイズ制限（10MB）を超えているためスキップされました。`);
                    return;
                }

                if (file.type.startsWith('image/')) {
                    await processImageSource(file);
                } else if (file.name.toLowerCase().endsWith('.txt') || file.type.startsWith('text/')) { // .txtファイルまたは一般的なテキストファイルは内容を保存
                    const reader = new FileReader();
                    reader.onload = function (e) {
                        persistentDocuments.push({ name: file.name, content: e.target.result });
                        saveDocuments();
                        updateFileListDisplay();
                    };
                    reader.readAsText(file);
                } else {
                    // .txt以外のファイルは名前のみ保存
                    persistentDocuments.push({ name: file.name, content: "" });
                    saveDocuments();
                    updateFileListDisplay();
                }
            });
            
            this.value = ''; // 連続アップロードのためにinputをクリア
        });
    }
});

// --- 貼り付け画像処理のイベントリスナー (OCR連携ロジック) ---
async function handlePaste(e) {
    const items = (e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData)).items;
    if (!items) return;

    let imageDetected = false;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            const blob = items[i].getAsFile();
            if (blob) {
                imageDetected = true;
                // 順番にダイアログを出すため await する
                await processImageSource(blob);
            }
        }
    }

    if (imageDetected) {
        e.preventDefault();
    }
}

// --- 画像プレビューとPNG保存準備処理 ---
async function processImageSource(fileOrBlob) {
    const getTimestamp = () => {
        const now = new Date();
        const pad = (num) => num.toString().padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    };

    const isFile = fileOrBlob instanceof File;
    let name = isFile ? fileOrBlob.name : `plower_image_${getTimestamp()}.png`;
    
    // genericな名前（image.pngやblob）はタイムスタンプ付きに強制変換
    if (name === "image.png" || name === "blob") {
        name = `plower_image_${getTimestamp()}.png`;
    }

    const pastePreview = document.getElementById('pastePreview');
    
    // 1. 画像を読み込んでプレビューを表示
    const base64Image = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(fileOrBlob);
    });

    const imageId = Date.now() + Math.random();
    pastedImages.push({ id: imageId, data: base64Image, name: name });

    // 2. プレビュー表示の生成
    const wrapper = document.createElement('div');
    wrapper.id = `preview-${imageId}`;
    wrapper.style.position = 'relative';
    wrapper.style.display = 'inline-block';
    wrapper.style.margin = '10px 10px 0 0';

    const thumb = document.createElement('img');
    thumb.src = base64Image;
    thumb.style.height = '80px';
    thumb.style.borderRadius = '4px';
    thumb.style.border = '1px solid #ccc';

    const closeBtn = document.createElement('div');
    closeBtn.innerHTML = '×';
    closeBtn.style.position = 'absolute';
    closeBtn.style.top = '-5px';
    closeBtn.style.right = '-5px';
    closeBtn.style.width = '20px';
    closeBtn.style.height = '20px';
    closeBtn.style.background = 'rgba(255,0,0,0.8)';
    closeBtn.style.color = 'white';
    closeBtn.style.borderRadius = '50%';
    closeBtn.style.textAlign = 'center';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.lineHeight = '18px';
    closeBtn.onclick = () => {
        pastedImages = pastedImages.filter(p => p.id !== imageId);
        wrapper.remove();
    };

    wrapper.appendChild(thumb);
    wrapper.appendChild(closeBtn);
    if (pastePreview) pastePreview.appendChild(wrapper);

    // 3. RAGソースへの保存を確認 (カスタムダイアログを表示)
    const titleMsg = isEn 
        ? `Save image to RAG source?` 
        : `画像をRAGソースに保存しますか？`;
    const finalName = await requestFileName(name, titleMsg);

    if (finalName) {
        try {
            await saveSingleFile('image', base64Image, finalName);
            await saveDocuments(); // IndexedDBには名前だけ、フォルダには実体を保存
            updateFileListDisplay();
            // 永続化したので一時リスト(プレビュー)から削除
            pastedImages = pastedImages.filter(p => p.id !== imageId);
            wrapper.remove();
        } catch (e) {
            console.error("Save failed:", e);
        }
    }
}

// ヘルパー: ファイル名入力を求めるカスタムダイアログ (拡張子以外を選択状態にする)
function requestFileName(defaultName, titleMsg) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
        overlay.style.zIndex = '3000';
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
        title.textContent = titleMsg;
        title.style.marginTop = '0';
        title.style.marginBottom = '15px';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultName;
        input.style.width = '100%';
        input.style.padding = '8px';
        input.style.marginBottom = '20px';
        input.style.boxSizing = 'border-box';
        input.style.fontSize = '16px';

        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.justifyContent = 'flex-end';
        btnContainer.style.gap = '10px';

        const close = (val) => {
            overlay.remove();
            resolve(val);
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = isEn ? 'Cancel' : 'キャンセル';
        cancelBtn.style.padding = '6px 12px';
        cancelBtn.style.cursor = 'pointer';
        cancelBtn.onclick = () => close(null);
        
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.padding = '6px 12px';
        okBtn.style.cursor = 'pointer';
        okBtn.onclick = () => close(input.value.trim() || defaultName);

        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(okBtn);
        dialog.appendChild(title);
        dialog.appendChild(input);
        dialog.appendChild(btnContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        setTimeout(() => {
            input.focus();
            const lastDotIndex = defaultName.lastIndexOf('.');
            if (lastDotIndex > 0) {
                input.setSelectionRange(0, lastDotIndex);
            } else {
                input.select();
            }
        }, 10);

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') okBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
        });
    });
}

// --- 貼付画像・テキストのファイル保存と永続化 ---
async function saveCurrentContentAsFile(specificName = null) {
    if (specificName instanceof Event) specificName = null;

    const pasteAreaContent = document.getElementById('pasteArea').value.trim();
    const getTimestamp = () => {
        const now = new Date();
        const pad = (num) => num.toString().padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    };

    if (pasteAreaContent !== "") {
        const defaultName = specificName || `plower_memo_${getTimestamp()}.txt`;
        const finalName = await requestFileName(defaultName, isEn ? "Name your memo:" : "メモの名前を入力してください:");
        if (finalName) {
            await saveSingleFile('text', pasteAreaContent, finalName);
        }
    }

    for (let imgObj of pastedImages) {
        const finalName = await requestFileName(imgObj.name, isEn ? "Name your image:" : "画像の名前を入力してください:");
        if (finalName) {
            await saveSingleFile('image', imgObj.data, finalName);
        }
    }

    if (pasteAreaContent === "" && pastedImages.length === 0) return;

    await saveDocuments();
    pastedImages = [];
    document.getElementById('pastePreview').innerHTML = '';
    document.getElementById('pasteArea').value = '';
    updateFileListDisplay();
    alert(isEn ? "Saved to RAG source." : "RAGソースに保存しました。");
}

async function saveSingleFile(type, content, name) {
    let blob;
    if (type === 'text') {
        blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    } else {
        const res = await fetch(content);
        blob = await res.blob();
    }
    persistentDocuments.push({ name: name, content: content });
    if (directoryHandle) {
        await saveBlobToDirectory(blob, name);
    } else {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }
}

// --- LLMリクエスト共通関数 (翻訳・回答生成で再利用) ---
async function performLlmRequest(modelSelect, llmPrompt, apiKey, onChunk = null, imageDatas = []) {
    let result = '';
    let endpoint = '';
    let bodyData = {};
    let isStreaming = false;
    
    const isGeminiCloudModel = modelSelect.toLowerCase().startsWith('gemini');
    const isSarasinaModel = modelSelect.toLowerCase().includes('sarasina');
    
    if (isGeminiCloudModel) {
        // --- Gemini Cloud Model ---
        if (!apiKey) throw new Error("Gemini API Key is required.");

        // 利用可能な最新かつ安定したモデルエイリアスのみに絞り込みます
        const candidates = [
        'gemini-2.5-flash',      // 最新の安定版（メイン利用に推奨）
        'gemini-2.5-flash-lite', // 軽量・高速版（コスト効率重視）
        'gemini-1.5-flash'       // 以前の安定版（予備として）
        ];

        let success = false;
        let lastError = null;

        for (const modelVersion of candidates) {
            try {
                console.log(`Trying Gemini model: ${modelVersion}`);
                const currentEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelVersion}:generateContent?key=${apiKey}`;
                const currentBody = {
                    contents: [{ 
                        parts: [
                            { text: llmPrompt },
                            ...imageDatas.map(data => ({ inline_data: { mime_type: "image/png", data: data.split(',')[1] } }))
                        ] 
                    }],
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
        bodyData = { model: modelSelect, prompt: llmPrompt, temperature: 0.1 };
        
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
        let hfUrl = localStorage.getItem('plowerHfUrl') || 'http://localhost:11434';
        if (hfUrl.endsWith('/')) hfUrl = hfUrl.slice(0, -1);
        endpoint = hfUrl.endsWith('/api/generate') ? hfUrl : `${hfUrl}/api/generate`;

        bodyData = {
            model: modelSelect,
            prompt: llmPrompt,
            stream: true,
            images: imageDatas.length > 0 ? imageDatas.map(data => data.split(',')[1]) : undefined,
            options: { temperature: 0.1, num_ctx: 4096 } // CPUリソースに合わせてコンテキスト窓を調整
        };

        return await fetchOllamaStream(endpoint, bodyData, onChunk);
    }
}

// Ollamaストリーミング処理のヘルパー
async function fetchOllamaStream(endpoint, bodyData, onChunk) {
    let result = '';
    const hfToken = localStorage.getItem('plowerHfToken');
    const headers = { 'Content-Type': 'application/json' };
    
    // Hugging Face Space等へのアクセス用に認証トークンを付与
    if (hfToken) {
        headers['Authorization'] = `Bearer ${hfToken}`;
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyData)
    });

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
         throw new Error("Server returned HTML. Check URL or Space status.");
    }

    if (!response.ok) {
        if (response.status === 404) throw new Error(`Model '${bodyData.model}' not found.`);
        if (response.status === 403) throw new Error(`Access Forbidden (403). Check Hugging Face Token or OLLAMA_ORIGINS.`);
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
    const geminiApiKey = document.getElementById('geminiApiKey').value.trim();

    if (!userInput) {
        alert(isEn ? "Please enter a question." : "質問を入力してください。");
        return;
    }

    if (pasteAreaContent || pastedImages.length > 0) {
        await saveCurrentContentAsFile();
    }

    sendButton.disabled = true;
    sendButton.textContent = isEn ? 'Sending...' : '送信中...';
    chatLog.innerHTML += `<p><strong>${isEn ? 'Question' : '質問'}:</strong> ${userInput || (isEn ? "(Analyze images)" : "(画像解析)")}</p>`;
    const responseParagraph = document.createElement('p');
    responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> (${isEn ? 'Processing...' : '処理中...'})`;
    chatLog.appendChild(responseParagraph);

    // 全てのRAGソースを統合
    let allDocuments = [...persistentDocuments];
    if (pasteAreaContent) {
        // 貼り付けエリアのテキストは一時文書として扱う
        allDocuments.push({ name: '貼付けテキスト(一時)', content: pasteAreaContent });
    }
    
    // --- フロントエンドでの検索処理を廃止 ---
    // ユーザーの指示に基づき、ローカルでの検索や翻訳を行わず、全ての文書をコンテキストとしてLLMに渡す。
    console.log(`全ての文書(${allDocuments.length}件)をコンテキストとして使用します。`);
    const context = allDocuments.map(doc => `File: ${doc.name}\nContent: ${doc.content}`).join('\n\n').slice(0, 15000); // 制限を少し緩和

    // プロンプトの生成: 質問と同じ言語で回答させるための指示を明確化。
    // ブラウザの言語設定(isEn)に依存せず、常に同じ構造のプロンプトを渡すことで、モデルの動作を安定させます。
    const prompt = `You are a helpful assistant. Your task is to answer the user's question based *only* on the provided [Reference Documents].

IMPORTANT INSTRUCTIONS:
1.  **Answer in the same language as the user's [Question].** (If the question is in Japanese, answer in Japanese. If in English, answer in English).
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
        const finalResult = await performLlmRequest(modelSelect, prompt, geminiApiKey, (chunkText) => {
            // ストリーミング更新
            responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ${chunkText.replace(/\n/g, '<br>')}`;
            chatLog.scrollTop = chatLog.scrollHeight;
        }, allDocuments.filter(d => d.name.match(/\.png$/i)).map(d => d.content));

        // 最終結果の表示 (非ストリーミングモデル用)
        responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ${finalResult.replace(/\n/g, '<br>')}`;
        
        pastedImages = [];
        document.getElementById('pastePreview').innerHTML = '';
        userInputElement.value = ''; // 質問欄をクリア

    } catch (error) {
        let errorMsg = error.message;
        // HTTPS環境からHTTP(ローカル)へ接続しようとして失敗した場合のヒントを追加
        const isNetworkError = error.name === 'TypeError' || error.message.toLowerCase().includes('fetch') || error.message.toLowerCase().includes('network');
        
        if (isNetworkError) {
            if (window.location.protocol === 'file:') {
                errorMsg += isEn 
                    ? "<br>⚠️ <strong>Security Restriction:</strong> You cannot make API requests when opening the file directly (file://). Please use a local server like 'Live Server' in VS Code or run 'npx serve'."
                    : "<br>⚠️ <strong>セキュリティ制限:</strong> ファイルを直接ブラウザで開いている(file://)ため、APIリクエストが遮断されました。VS CodeのLive Serverを使用するか、'npx serve' 等のローカルサーバー経由で開いてください。";
            } else {
                errorMsg += isEn 
                    ? "<br>⚠️ Request Blocked: Check your Internet connection and API Token. If using Gemma 3, make sure you've accepted the license on the Hugging Face model page."
                    : "<br>⚠️ リクエストが遮断されました: トークンの権限、ネット接続、広告ブロックを確認してください。Gemma 3を使用する場合、HFのモデルページでライセンスへの同意が必要です。";
                errorMsg += `<br><small>Debug Info: ${error.name} - ${error.message}</small>`;
                
                if (window.location.protocol === 'https:') {
                    errorMsg += isEn ? " (Mixed Content check)" : " (HTTPS/HTTP混在の可能性)";
                }
            }
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
    document.getElementById('saveOcrButton').addEventListener('click', () => saveCurrentContentAsFile());
    document.getElementById('syncFolderButton').addEventListener('click', syncLocalFolder);
    
    // DOMロード後にイベントリスナーを登録 (安全策)
    const pasteArea = document.getElementById('pasteArea');
    
    if (pasteArea && !document.getElementById('pastePreview')) {
        const previewDiv = document.createElement('div');
        previewDiv.id = 'pastePreview';
        pasteArea.parentNode.insertBefore(previewDiv, pasteArea);
    }

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
            alert(isEn ? 'Gemini API Key saved.' : 'Gemini APIキーを保存しました。次回から自動入力されます。');
        } else {
            alert(isEn ? 'Key is empty. Use "Delete Key" button to remove it.' : 'キーが空です。削除する場合は「キー削除」ボタンを使用してください。');
        }
    });

    // 削除ボタンを動的に追加
    const deleteKeyBtn = document.createElement('button');
    deleteKeyBtn.textContent = isEn ? 'Delete Key' : 'キー削除';
    deleteKeyBtn.style.marginLeft = '5px';
    deleteKeyBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerGeminiApiKey');
        document.getElementById('geminiApiKey').value = '';
        alert(isEn ? 'Gemini API Key deleted.' : '保存されたGemini APIキーを削除しました。');
    });
    saveKeyBtn.parentNode.insertBefore(deleteKeyBtn, saveKeyBtn.nextSibling);
    
    // --- Hugging Face Access Token のロードと保存処理 ---
    const savedHfToken = localStorage.getItem('plowerHfToken');
    if (savedHfToken) {
        document.getElementById('hfToken').value = savedHfToken;
    }

    const saveHfTokenBtn = document.getElementById('saveHfTokenButton');
    if (saveHfTokenBtn) {
        saveHfTokenBtn.addEventListener('click', () => {
            const token = document.getElementById('hfToken').value.trim();
            if (token) {
                localStorage.setItem('plowerHfToken', token);
                alert(isEn ? 'HuggingFace Token saved.' : 'HuggingFaceトークンを保存しました。');
            } else {
                alert(isEn ? 'Token is empty. Use "Delete Token" button to remove it.' : 'トークンが空です。削除する場合は「トークン削除」ボタンを使用してください。');
            }
        });

        // トークン削除ボタンの追加
        const deleteHfTokenBtn = document.createElement('button');
        deleteHfTokenBtn.textContent = isEn ? 'Delete Token' : 'トークン削除';
        deleteHfTokenBtn.style.marginLeft = '5px';
        deleteHfTokenBtn.addEventListener('click', () => {
            localStorage.removeItem('plowerHfToken');
            document.getElementById('hfToken').value = '';
            alert(isEn ? 'HuggingFace Token deleted.' : '保存されたHuggingFaceトークンを削除しました。');
        });
        saveHfTokenBtn.parentNode.insertBefore(deleteHfTokenBtn, saveHfTokenBtn.nextSibling);
    }

    // --- HuggingFace URL設定の初期化とイベントリスナー ---
    const hfUrlInput = document.getElementById('hfUrlInput');
    if (hfUrlInput) {
        hfUrlInput.value = localStorage.getItem('plowerHfUrl') || 'http://localhost:11434';
    }

    const saveHfUrlBtn = document.getElementById('saveHfUrlButton');
    saveHfUrlBtn.addEventListener('click', () => {
        let url = hfUrlInput.value.trim();
        if (!url) url = 'http://localhost:11434';
        let finalMessage = isEn ? 'HuggingFace URL saved.' : 'HuggingFaceのURL設定を保存しました。';
        
        // Hugging Face SpacesのWeb URLが入力された場合、Direct URLに自動変換する
        // 例: https://huggingface.co/spaces/username/spacename -> https://username-spacename.hf.space
        const hfMatch = url.match(/^https?:\/\/huggingface\.co\/spaces\/([^\/]+)\/([^\/]+)\/?$/);
        if (hfMatch) {
            const username = hfMatch[1].toLowerCase();
            const spacename = hfMatch[2].toLowerCase();
            url = `https://${username}-${spacename}.hf.space`;
            hfUrlInput.value = url; // 入力欄も更新
            finalMessage = isEn ? 'Converted Hugging Face Space URL to Direct URL format and saved.' : 'Hugging Face SpaceのWeb URLを検出し、API用のDirect URL形式に自動変換して保存しました。';
        }
        
        localStorage.setItem('plowerHfUrl', url);
        alert(finalMessage);
    });

    // HuggingFace URL削除ボタンを動的に追加
    const deleteHfUrlBtn = document.createElement('button');
    deleteHfUrlBtn.textContent = isEn ? 'Delete URL' : 'URL削除';
    deleteHfUrlBtn.style.marginLeft = '5px';
    deleteHfUrlBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerHfUrl');
        if (hfUrlInput) hfUrlInput.value = 'http://localhost:11434';
        alert(isEn ? 'Saved URL deleted (Reset to default).' : '保存されたURL設定を削除しました（デフォルトのlocalhostに戻りました）。');
    });
    saveHfUrlBtn.parentNode.insertBefore(deleteHfUrlBtn, saveHfUrlBtn.nextSibling);

    // Enterキーでの送信機能
    document.getElementById('userInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendToModel();
        }
    });
});