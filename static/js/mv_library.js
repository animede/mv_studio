(() => {
  const SESSION_KEY = 'comfyui_api_client_session_id';
  const state = {
    items: [],
    loading: false,
    uploadBusy: false,
    importBusy: false,
    metadataBusyId: '',
    deleteBusyId: '',
    error: '',
    loadedAt: 0,
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function getSessionId() {
    try {
      let id = localStorage.getItem(SESSION_KEY);
      if (!id) {
        id = (crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
        localStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch (_error) {
      return `tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
  }

  function normalizeTimestamp(value) {
    const numeric = Number(value || 0);
    if (!numeric) return null;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDateTime(ts) {
    if (!ts) return '未取得';
    try {
      return new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(Number(ts)));
    } catch (_error) {
      return '未取得';
    }
  }

  function formatFileSize(bytes) {
    const value = Math.max(0, Number(bytes || 0) || 0);
    if (!value) return 'サイズ不明';
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
    return `${(value / (1024 ** 3)).toFixed(2)} GB`;
  }

  function formatDurationText(seconds) {
    const value = Math.max(0, Number(seconds || 0) || 0);
    if (!value) return '尺不明';
    if (value < 60) return `${value.toFixed(value >= 10 ? 0 : 1)}秒`;
    const minutes = Math.floor(value / 60);
    const remain = Math.round(value % 60);
    return `${minutes}分${String(remain).padStart(2, '0')}秒`;
  }

  function getGeneratedMvKindLabel(kind) {
    const normalized = String(kind || 'movie').trim().toLowerCase();
    if (normalized === 'final') return '完成MV';
    if (normalized === 'clip') return '中間クリップ';
    if (normalized === 'uploaded') return 'アップロード';
    if (normalized === 'imported') return 'フォルダ取込';
    return '出力動画';
  }

  function getGeneratedMvSourceLabel(sourceType) {
    const normalized = String(sourceType || 'generated').trim().toLowerCase();
    if (normalized === 'uploaded') return 'UIアップロード';
    if (normalized === 'imported') return 'フォルダ取込';
    return '生成出力';
  }

  function getGeneratedMvDefaultTitle(filename = '') {
    const raw = String(filename || '').trim();
    if (!raw) return 'MV';
    return raw.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim() || raw;
  }

  function normalizeItem(item) {
    if (!item || typeof item !== 'object') return null;
    const rawDuration = Number(item.durationSec ?? item.duration_sec ?? 0);
    return {
      id: String(item.id || ''),
      filename: String(item.filename || ''),
      subfolder: String(item.subfolder || ''),
      previewUrl: String(item.previewUrl || item.preview_url || ''),
      kind: String(item.kind || 'movie'),
      title: String(item.title || ''),
      memo: String(item.memo || ''),
      sourceType: String(item.sourceType || item.source_type || 'generated'),
      originalFilename: String(item.originalFilename || item.original_filename || item.filename || ''),
      importedFrom: String(item.importedFrom || item.imported_from || ''),
      registeredAt: normalizeTimestamp(item.registeredAt || item.registered_at),
      updatedAt: normalizeTimestamp(item.updatedAt || item.updated_at),
      sizeBytes: Math.max(0, Number(item.sizeBytes || item.size_bytes || 0) || 0),
      durationSec: Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null,
    };
  }

  function setStatus(message, tone = 'info') {
    if (!els.status) return;
    els.status.textContent = message;
    if (tone === 'success') {
      els.status.style.background = 'rgba(52, 211, 153, 0.16)';
      els.status.style.borderColor = 'rgba(52, 211, 153, 0.28)';
      els.status.style.color = '#d1fae5';
      return;
    }
    if (tone === 'warning') {
      els.status.style.background = 'rgba(251, 191, 36, 0.16)';
      els.status.style.borderColor = 'rgba(251, 191, 36, 0.28)';
      els.status.style.color = '#fef3c7';
      return;
    }
    els.status.style.background = 'rgba(59, 130, 246, 0.15)';
    els.status.style.borderColor = 'rgba(110, 168, 254, 0.28)';
    els.status.style.color = '#dbeafe';
  }

  function renderSummary() {
    const uploadedCount = state.items.filter((item) => item.sourceType === 'uploaded').length;
    const importedCount = state.items.filter((item) => item.sourceType === 'imported').length;
    const generatedCount = state.items.filter((item) => item.sourceType === 'generated').length;
    els.summary.innerHTML = `
      <div class="canvas-summary-grid mv-library-summary-cards">
        <div class="summary-card summary-card-primary"><span class="summary-key">登録件数</span><strong>${escapeHtml(state.items.length)}</strong></div>
        <div class="summary-card"><span class="summary-key">生成出力</span><strong>${escapeHtml(generatedCount)}</strong></div>
        <div class="summary-card"><span class="summary-key">アップロード</span><strong>${escapeHtml(uploadedCount)}</strong></div>
        <div class="summary-card"><span class="summary-key">フォルダ取込</span><strong>${escapeHtml(importedCount)}</strong></div>
      </div>
      <ul class="detail-list mv-library-summary-list">
        <li><strong>最終取得</strong>${escapeHtml(state.loadedAt ? formatDateTime(state.loadedAt) : '未取得')}</li>
        <li><strong>セッションID</strong>${escapeHtml(getSessionId())}</li>
      </ul>
    `;
  }

  function renderActions() {
    els.actionContent.innerHTML = `
      <div class="mv-library-manage-grid">
        <section class="mv-library-manage-card">
          <h4>UIから動画を登録</h4>
          <p class="field-help">手元のMVファイルをアップロードして output/movie に登録します。</p>
          <label class="preset-select-group">
            <span class="field-label">動画ファイル</span>
            <input id="mvLibraryUploadInput" class="text-input" type="file" accept="video/*,.mp4,.mov,.webm,.mkv,.avi" ${state.uploadBusy ? 'disabled' : ''} />
          </label>
          <label class="preset-select-group">
            <span class="field-label">タイトル</span>
            <input id="mvLibraryUploadTitleInput" class="text-input" type="text" placeholder="例: 2025 夏ライブ MV" ${state.uploadBusy ? 'disabled' : ''} />
          </label>
          <label class="preset-select-group">
            <span class="field-label">メモ</span>
            <textarea id="mvLibraryUploadMemoInput" class="prompt-textarea generated-mv-note-input" rows="3" placeholder="補足メモや管理メモ" ${state.uploadBusy ? 'disabled' : ''}></textarea>
          </label>
          <div class="generated-mv-links">
            <button id="mvLibraryUploadBtn" class="detail-action-btn primary" type="button" ${state.uploadBusy ? 'disabled' : ''}>${state.uploadBusy ? '⏳ 登録中...' : '⬆️ アップロード登録'}</button>
          </div>
        </section>

        <section class="mv-library-manage-card">
          <h4>任意フォルダからインポート</h4>
          <p class="field-help">サーバー上のフォルダを指定し、中の動画をまとめて output/movie に取り込みます。</p>
          <label class="preset-select-group">
            <span class="field-label">フォルダパス</span>
            <input id="mvLibraryImportPathInput" class="text-input" type="text" placeholder="例: /home/user/archive/mv" ${state.importBusy ? 'disabled' : ''} />
          </label>
          <label class="character-inline-option">
            <input id="mvLibraryImportRecursiveInput" type="checkbox" checked ${state.importBusy ? 'disabled' : ''} />
            <span>サブフォルダも再帰的に検索</span>
          </label>
          <div class="generated-mv-links">
            <button id="mvLibraryImportBtn" class="detail-action-btn secondary" type="button" ${state.importBusy ? 'disabled' : ''}>${state.importBusy ? '⏳ 取込中...' : '📁 フォルダをインポート'}</button>
            <button id="generatedMvRefreshBtn" class="detail-action-btn secondary compact" type="button" ${state.loading ? 'disabled' : ''}>${state.loading ? '更新中...' : '一覧を更新'}</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderList() {
    if (state.loading && !state.items.length) {
      els.listContent.innerHTML = '<div class="character-output-placeholder">生成済みMV一覧を読み込んでいます...</div>';
      return;
    }

    if (!state.items.length) {
      els.listContent.innerHTML = `
        <div class="generated-mv-toolbar">
          <div class="field-help">${escapeHtml(state.error || 'まだ保存済みMVは見つかっていません')}</div>
        </div>
        <div class="character-output-placeholder">先にMVを生成するか、この画面からアップロード / インポートしてください。</div>
      `;
      return;
    }

    const cards = state.items.map((item) => {
      const saveId = `${item.subfolder || ''}/${item.filename || ''}`.replace(/^\//, '');
      const saveBusy = state.metadataBusyId === saveId;
      const deleteBusy = state.deleteBusyId === saveId;
      return `
        <article class="generated-mv-card" data-mv-library-card data-mv-filename="${escapeHtml(item.filename || '')}" data-mv-subfolder="${escapeHtml(item.subfolder || '')}">
          <div class="generated-mv-card-head">
            <span class="generated-mv-badge ${escapeHtml(item.kind || 'movie')}">${escapeHtml(getGeneratedMvKindLabel(item.kind))}</span>
            <span class="generated-mv-card-time">${escapeHtml(getGeneratedMvSourceLabel(item.sourceType))}</span>
          </div>
          ${item.previewUrl
            ? `<video controls playsinline preload="metadata" class="scene-video-player final-mv-player generated-mv-player" src="${escapeHtml(item.previewUrl)}"></video>`
            : '<div class="character-output-placeholder">プレビューを表示できません</div>'}
          <div class="generated-mv-card-body">
            <div class="generated-mv-filename" title="${escapeHtml(item.filename || '')}">${escapeHtml(item.filename || 'movie.mp4')}</div>
            <label class="generated-mv-field">
              <span class="field-label">タイトル</span>
              <input class="text-input generated-mv-title-input" data-mv-title-input type="text" value="${escapeHtml(item.title || getGeneratedMvDefaultTitle(item.filename))}" ${(saveBusy || deleteBusy) ? 'disabled' : ''} />
            </label>
            <label class="generated-mv-field">
              <span class="field-label">メモ</span>
              <textarea class="prompt-textarea generated-mv-note-input" data-mv-memo-input rows="3" ${(saveBusy || deleteBusy) ? 'disabled' : ''}>${escapeHtml(item.memo || '')}</textarea>
            </label>
            <div class="generated-mv-meta">${escapeHtml(`${formatDurationText(item.durationSec)} ・ ${formatFileSize(item.sizeBytes)} ・ 更新 ${formatDateTime(item.updatedAt)}`)}</div>
            <div class="generated-mv-meta">${escapeHtml(`元ファイル: ${item.originalFilename || item.filename || '不明'}`)}</div>
            ${item.importedFrom ? `<div class="generated-mv-meta">${escapeHtml(`取込元: ${item.importedFrom}`)}</div>` : ''}
            ${item.registeredAt ? `<div class="generated-mv-meta">${escapeHtml(`登録日時: ${formatDateTime(item.registeredAt)}`)}</div>` : ''}
            <div class="generated-mv-links">
              ${item.previewUrl ? `<a class="detail-action-btn secondary compact" href="${escapeHtml(item.previewUrl)}" target="_blank" rel="noreferrer">開く</a>` : ''}
              <button class="detail-action-btn secondary compact" type="button" data-mv-library-save ${(saveBusy || deleteBusy) ? 'disabled' : ''}>${saveBusy ? '保存中...' : 'タイトル/メモ保存'}</button>
              <button class="detail-action-btn secondary compact danger" type="button" data-mv-library-delete ${(saveBusy || deleteBusy) ? 'disabled' : ''}>${deleteBusy ? '削除中...' : '削除'}</button>
            </div>
          </div>
        </article>
      `;
    }).join('');

    els.listContent.innerHTML = `
      <div class="generated-mv-toolbar">
        <div class="field-help">${escapeHtml(state.error || `最終取得: ${formatDateTime(state.loadedAt)}`)}</div>
      </div>
      <div class="generated-mv-grid">${cards}</div>
    `;
  }

  function renderAll() {
    renderSummary();
    renderActions();
    renderList();
  }

  async function refreshGallery() {
    if (state.loading) return;
    state.loading = true;
    state.error = '';
    setStatus('一覧を読み込み中...', 'info');
    renderAll();
    try {
      const response = await fetch(`/api/v1/production/final-mv/list?client_session_id=${encodeURIComponent(getSessionId())}&limit=60`, {
        cache: 'no-store',
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const data = await response.json();
      state.items = Array.isArray(data?.items) ? data.items.map((item) => normalizeItem(item)).filter(Boolean) : [];
      state.loadedAt = Date.now();
      setStatus(`一覧を更新しました（${state.items.length}件）`, 'success');
    } catch (error) {
      state.error = error?.message || '一覧の取得に失敗しました';
      setStatus(state.error, 'warning');
    } finally {
      state.loading = false;
      renderAll();
    }
  }

  async function uploadFile(file, { title = '', memo = '' } = {}) {
    if (!file) throw new Error('登録する動画ファイルを選択してください');
    if (state.uploadBusy) return;
    state.uploadBusy = true;
    setStatus('MVファイルをアップロード登録中です...', 'info');
    renderAll();
    try {
      const formData = new FormData();
      formData.append('client_session_id', getSessionId());
      formData.append('title', String(title || '').trim());
      formData.append('memo', String(memo || '').trim());
      formData.append('file', file);
      const response = await fetch('/api/v1/production/final-mv/library/upload', {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      setStatus('MVファイルを登録しました', 'success');
      await refreshGallery();
    } finally {
      state.uploadBusy = false;
      renderAll();
    }
  }

  async function importFolder(folderPath, { recursive = true } = {}) {
    const normalizedPath = String(folderPath || '').trim();
    if (!normalizedPath) throw new Error('インポート元フォルダを入力してください');
    if (state.importBusy) return;
    state.importBusy = true;
    setStatus('フォルダ内のMVをインポート中です...', 'info');
    renderAll();
    try {
      const response = await fetch('/api/v1/production/final-mv/library/import-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          folder_path: normalizedPath,
          recursive: !!recursive,
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      setStatus(`フォルダ取込を完了しました（追加 ${Number(result?.imported_count || 0)} / 既存 ${Number(result?.skipped_count || 0)}）`, 'success');
      await refreshGallery();
    } finally {
      state.importBusy = false;
      renderAll();
    }
  }

  async function saveMetadata({ filename, subfolder = '', title = '', memo = '' }) {
    const safeFilename = String(filename || '').trim();
    if (!safeFilename) throw new Error('保存対象のMVが見つかりません');
    const saveId = `${subfolder}/${safeFilename}`.replace(/^\//, '');
    if (state.metadataBusyId === saveId) return;
    state.metadataBusyId = saveId;
    setStatus('タイトルとメモを保存中です...', 'info');
    renderAll();
    try {
      const response = await fetch('/api/v1/production/final-mv/library/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          filename: safeFilename,
          subfolder: String(subfolder || '').trim(),
          title: String(title || '').trim(),
          memo: String(memo || '').trim(),
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      setStatus('タイトルとメモを保存しました', 'success');
      await refreshGallery();
    } finally {
      state.metadataBusyId = '';
      renderAll();
    }
  }

  async function deleteItem({ filename, subfolder = '' }) {
    const safeFilename = String(filename || '').trim();
    if (!safeFilename) throw new Error('削除対象のMVが見つかりません');
    const deleteId = `${subfolder}/${safeFilename}`.replace(/^\//, '');
    if (state.deleteBusyId === deleteId) return;
    const ok = window.confirm(`MV「${safeFilename}」を削除しますか？\noutput/movie の動画ファイルと管理メタデータを削除します。`);
    if (!ok) return;

    state.deleteBusyId = deleteId;
    setStatus('MVを削除中です...', 'info');
    renderAll();
    try {
      const params = new URLSearchParams();
      params.set('client_session_id', getSessionId());
      if (String(subfolder || '').trim()) {
        params.set('subfolder', String(subfolder || '').trim());
      }
      const response = await fetch(`/api/v1/production/final-mv/library/${encodeURIComponent(safeFilename)}?${params.toString()}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      setStatus('MVを削除しました', 'success');
      await refreshGallery();
    } finally {
      state.deleteBusyId = '';
      renderAll();
    }
  }

  function bindEvents() {
    document.body.addEventListener('click', async (event) => {
      if (event.target.closest('#generatedMvRefreshBtn')) {
        try {
          await refreshGallery();
        } catch (error) {
          setStatus(error.message || '一覧の更新に失敗しました', 'warning');
        }
        return;
      }

      if (event.target.closest('#mvLibraryUploadBtn')) {
        try {
          const file = $('mvLibraryUploadInput')?.files?.[0] || null;
          await uploadFile(file, {
            title: $('mvLibraryUploadTitleInput')?.value || '',
            memo: $('mvLibraryUploadMemoInput')?.value || '',
          });
        } catch (error) {
          setStatus(error.message || 'MVファイルの登録に失敗しました', 'warning');
        }
        return;
      }

      if (event.target.closest('#mvLibraryImportBtn')) {
        try {
          await importFolder($('mvLibraryImportPathInput')?.value || '', {
            recursive: !!$('mvLibraryImportRecursiveInput')?.checked,
          });
        } catch (error) {
          setStatus(error.message || 'MVフォルダ取込に失敗しました', 'warning');
        }
        return;
      }

      if (event.target.closest('[data-mv-library-save]')) {
        try {
          const card = event.target.closest('[data-mv-library-card]');
          if (!card) throw new Error('保存対象が見つかりません');
          await saveMetadata({
            filename: card.getAttribute('data-mv-filename') || '',
            subfolder: card.getAttribute('data-mv-subfolder') || '',
            title: card.querySelector('[data-mv-title-input]')?.value || '',
            memo: card.querySelector('[data-mv-memo-input]')?.value || '',
          });
        } catch (error) {
          setStatus(error.message || 'タイトル / メモ保存に失敗しました', 'warning');
        }
        return;
      }

      if (event.target.closest('[data-mv-library-delete]')) {
        try {
          const card = event.target.closest('[data-mv-library-card]');
          if (!card) throw new Error('削除対象が見つかりません');
          await deleteItem({
            filename: card.getAttribute('data-mv-filename') || '',
            subfolder: card.getAttribute('data-mv-subfolder') || '',
          });
        } catch (error) {
          setStatus(error.message || 'MVの削除に失敗しました', 'warning');
        }
      }
    });

    document.body.addEventListener('change', (event) => {
      if (event.target.matches('#mvLibraryUploadInput')) {
        const file = event.target.files?.[0] || null;
        const titleInput = $('mvLibraryUploadTitleInput');
        if (file && titleInput && !String(titleInput.value || '').trim()) {
          titleInput.value = getGeneratedMvDefaultTitle(file.name || '');
        }
      }
    });
  }

  async function init() {
    Object.assign(els, {
      status: $('mvLibraryStatus'),
      summary: $('mvLibrarySummary'),
      actionContent: $('mvLibraryActionContent'),
      listContent: $('mvLibraryListContent'),
    });
    renderAll();
    bindEvents();
    await refreshGallery();
  }

  window.addEventListener('DOMContentLoaded', init);
})();
