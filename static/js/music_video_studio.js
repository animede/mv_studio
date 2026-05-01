(() => {
  const STORAGE_KEY = 'mvStudioProductionState';
  const SESSION_KEY = 'comfyui_api_client_session_id';
  const MAX_SCENE_COUNT = 40;
  const DEFAULT_SCENE_DURATION_MAX_SEC = 10;
  const LTX_SCENE_DURATION_MAX_SEC = 15;

  const state = {
    config: null,
    selectedPresetId: '',
    selectedPipelinePresetId: '',
    selectedStepId: '',
    mode: 'new',
    characterStep: {
      dropSlots: [null, null, null],
      ref3ModeEnabled: true,
      ref3UseMode: 'background',
      characters: [],
      selectedCharacterToken: '',
      imagePrompt: '',
      keyImageAnalysis: '',
      keyImageAnalysisRaw: null,
      characterImage: null,
      characterSheetImage: null,
      charSheetNobg: false,
      notice: null,
    },
    storyStep: {
      idea: '',
      scenarioText: '',
      worldNotes: '',
      genre: '',
      sceneCount: 5,
      targetDurationSec: 30,
      lyricsEnabled: false,
      useCharacterContext: true,
      notice: null,
      generatedOutline: [],
      lastGeneratedAt: null,
    },
    musicStep: {
      musicPrompt: '',
      lyricsText: '',
      tagsText: '',
      arrangementNotes: '',
      title: '',
      durationOverrideSec: null,
      generatedAudio: null,
      bpm: 118,
      keySignature: '',
      vocalLanguage: 'ja',
      hasVocals: true,
      instrumentalFocus: false,
      useStoryContext: true,
      useCharacterContext: true,
      autoSuggestScenePlanOnImport: true,
      notice: null,
      lastGeneratedAt: null,
    },
    sceneImageStep: {
      scenePrompts: [],
      selectedSceneIndex: 0,
      useStoryContext: true,
      useMusicContext: true,
      useCharacterContext: true,
      cfg: 1.0,
      denoise: 1.0,
      notice: null,
      lastPromptGeneratedAt: null,
    },
    sceneVideoStep: {
      sceneVideos: [],
      selectedSceneIndex: 0,
      useScenePrompt: true,
      useMusicContext: true,
      audioOff: false,
      fps: 25,
      workflowMode: '',
      notice: null,
      lastGeneratedAt: null,
    },
    finalMvStep: {
      clipVideo: null,
      finalVideo: null,
      notice: null,
      lastRenderedAt: null,
    },
    canvas: {
      id: '',
      name: '',
      createdAt: null,
      updatedAt: null,
    },
    lastSavedAt: null,
  };

  const els = {};
  let saveTimer = null;
  let characterImageGenerationBusy = false;
  let storyGenerationBusy = false;
  let musicPlanGenerationBusy = false;
  let musicAudioGenerationBusy = false;
  let musicAudioTrimBusy = false;
  let scenePromptGenerationBusy = false;
  let scenePlanGenerationBusy = false;
  let sceneImageGenerationBusy = false;
  let sceneVideoGenerationBusy = false;
  let finalMvRenderBusy = false;
  let sceneImageGenerationAbortController = null;
  let sceneVideoGenerationAbortController = null;
  let sceneImageBatchCancelRequested = false;
  let sceneVideoBatchCancelRequested = false;
  const musicWaveformCache = new Map();
  let musicWaveformRenderToken = 0;
  let musicWaveformPlaybackRafId = 0;

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

  function formatDateTime(ts) {
    if (!ts) return '未保存';
    try {
      const normalizedTs = Number(ts) > 0 && Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
      return new Intl.DateTimeFormat('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(normalizedTs));
    } catch (_error) {
      return '未保存';
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

  function normalizeSceneTransitionType(value, { sceneIndex = null } = {}) {
    const normalized = String(value || '').trim().toLowerCase();
    if (Number(sceneIndex) === 1) return 'none';
    if (normalized === 'cut' || normalized === 'crossfade' || normalized === 'fade_black' || normalized === 'flf') {
      return normalized;
    }
    return 'none';
  }

  function normalizeSceneTransitionReason(value) {
    return String(value || '').trim();
  }

  function getSceneTransitionLabel(value) {
    const normalized = normalizeSceneTransitionType(value);
    if (normalized === 'cut') return 'カット';
    if (normalized === 'crossfade') return 'クロスフェード';
    if (normalized === 'fade_black') return '暗転';
    if (normalized === 'flf') return 'FLF補間';
    return 'なし';
  }

  function getSceneTransitionDescription(value, { sceneIndex = null, pipelinePresetId = '', workflowMode = '' } = {}) {
    const normalized = normalizeSceneTransitionType(value, { sceneIndex });
    const pipelineId = String(pipelinePresetId || state.selectedPipelinePresetId || '').trim().toLowerCase();
    const mode = String(workflowMode || getSelectedSceneVideoWorkflowMode() || '').trim().toLowerCase();
    const isMixed = pipelineId.includes('mixed');
    const isCharacterMixed = pipelineId.includes('char_edit_i2v_mixed');
    const isEditMixed = pipelineId.includes('ext_i2i_i2v_mixed');
    const isLtx = mode === 'ltx' || mode === 'ltx_flf';
    if (Number(sceneIndex) === 1 || normalized === 'none') {
      return '先頭シーン、または明示的に遷移を入れない境界です。';
    }
    if (normalized === 'cut') {
      if (isEditMixed) return '場面差や編集点をはっきり見せたいときの切替です。編集向け mixed では基準になりやすいです。';
      return 'テンポよく場面を切り替える基本遷移です。差分をはっきり見せたいときに向きます。';
    }
    if (normalized === 'crossfade') {
      if (isMixed) return 'mixed 系でよく使う中間遷移です。ムードを保ちつつ、場面を自然につなぎます。';
      return '前後の雰囲気が近い場面を柔らかくつなぐ遷移です。';
    }
    if (normalized === 'fade_black') {
      return 'セクション切替やサビ前後など、流れを一度リセットしたいときに向く遷移です。';
    }
    if (normalized === 'flf') {
      if (isCharacterMixed) return 'キャラ連続性を強く保ちたい mixed 向け遷移です。似た構図・似た被写体で効果が高いです。';
      if (isLtx) return 'LTX FLF と相性のよい連続補間です。隣接シーンが近い内容なら滑らかにつながります。';
      return '前後シーンの連続性が高いときに使う補間遷移です。構図差が大きい場合は不向きです。';
    }
    return 'この境界では標準的な遷移を使います。';
  }

  function getPipelineTransitionGuidance(pipelinePresetId = '', workflowMode = '') {
    const pipelineId = String(pipelinePresetId || state.selectedPipelinePresetId || '').trim().toLowerCase();
    const mode = String(workflowMode || getSelectedSceneVideoWorkflowMode() || '').trim().toLowerCase();
    const isLtx = mode === 'ltx' || mode === 'ltx_flf';
    if (pipelineId.includes('char_edit_i2v_mixed')) {
      return 'この mixed はキャラ連続性重視です。似た場面では FLF、穏やかな差分はクロスフェード、章切替は暗転を優先します。';
    }
    if (pipelineId.includes('ext_i2i_i2v_mixed')) {
      return 'この mixed は編集しやすさ重視です。クロスフェード / 暗転を中心にし、FLF は極めて近い場面だけに絞ります。';
    }
    if (pipelineId.includes('mixed')) {
      return 'mixed 系では、連続性の高い場面は FLF、雰囲気変化はクロスフェード、強い区切りは暗転を使い分けます。';
    }
    if (pipelineId.includes('scene_cut')) {
      return 'scene_cut 系では、まずカットを基準に考え、近い場面だけクロスフェードを加えるのが自然です。';
    }
    if (pipelineId.includes('flf') || mode === 'flf' || mode === 'ltx_flf') {
      return `連続系フローです。${isLtx ? 'LTX FLF' : 'FLF'} を使い、似た場面を滑らかにつなぐ提案を優先します。`;
    }
    return '現在のフローでは、場面差を見ながらカットとクロスフェードを基準に提案します。';
  }

  function createCanvasName(presetName) {
    const stamp = new Intl.DateTimeFormat('ja-JP', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
    return presetName ? `${presetName} ${stamp}` : `新規キャンバス ${stamp}`;
  }

  function defaultStepIdForPreset(preset) {
    if (!preset || !Array.isArray(preset.steps) || !preset.steps.length) return '';
    return String(preset.steps[0].id || '');
  }

  function getPresetById(presetId = state.selectedPresetId) {
    return state.config?.presets?.find((preset) => String(preset.id) === String(presetId)) || null;
  }

  function getCurrentStep() {
    const preset = getPresetById();
    if (!preset) return null;
    return preset.steps.find((step) => String(step.id) === String(state.selectedStepId)) || preset.steps[0] || null;
  }

  function getPipelineOptionsForPreset(preset = getPresetById()) {
    return Array.isArray(preset?.pipeline_options) ? preset.pipeline_options : [];
  }

  function defaultPipelinePresetIdForPreset(preset = getPresetById()) {
    const options = getPipelineOptionsForPreset(preset);
    if (!options.length) return '';
    const configured = String(preset?.default_pipeline_preset_id || '').trim();
    if (configured && options.some((item) => String(item.id) === configured)) {
      return configured;
    }
    return String(options[0]?.id || '');
  }

  function getSelectedPipelineOption(preset = getPresetById()) {
    const options = getPipelineOptionsForPreset(preset);
    return options.find((item) => String(item.id) === String(state.selectedPipelinePresetId)) || null;
  }

  function getModeMeta(modeId = state.mode) {
    return state.config?.modes?.find((mode) => String(mode.id) === String(modeId)) || null;
  }

  function getModeSpecificHint(modeId, step) {
    const title = step?.title || 'このSTEP';
    if (modeId === 'step') {
      return `STEP制作では ${title} から着手し、必要なら前後STEPだけを順番に呼び出す想定です。`;
    }
    if (modeId === 'edit') {
      return `編集モードでは既存成果物を保持しつつ、${title} の差し替え範囲と影響範囲を確認して再処理します。`;
    }
    return `自動制作では ${title} を起点に、後続STEPへ成果物を自動的に受け渡しながら進める想定です。`;
  }

  function payloadFromState() {
    return {
      selectedPresetId: state.selectedPresetId,
      selectedPipelinePresetId: state.selectedPipelinePresetId,
      selectedStepId: state.selectedStepId,
      mode: state.mode,
      characterStep: { ...state.characterStep },
      storyStep: { ...state.storyStep },
      musicStep: { ...state.musicStep },
      sceneImageStep: { ...state.sceneImageStep },
      sceneVideoStep: { ...state.sceneVideoStep },
      finalMvStep: { ...state.finalMvStep },
      canvas: { ...state.canvas },
      lastSavedAt: state.lastSavedAt,
    };
  }

  function persistLocalState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payloadFromState()));
    } catch (_error) {
      // noop
    }
  }

  async function persistRemoteState() {
    try {
      const response = await fetch('/api/v1/production/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          state: payloadFromState(),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.lastSavedAt = normalizeTimestamp(data?.updated_at) || Date.now();
      state.canvas.updatedAt = state.lastSavedAt;
      persistLocalState();
      renderCanvasSummary();
    } catch (_error) {
      renderSaveStatus('ローカル保持中', false);
    }
  }

  function scheduleSave() {
    persistLocalState();
    renderSaveStatus('保存待機中', false);
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      persistRemoteState();
    }, 320);
  }

  function mergeState(source) {
    if (!source || typeof source !== 'object') return;
    if (typeof source.selectedPresetId === 'string') state.selectedPresetId = source.selectedPresetId;
    if (typeof source.selectedPipelinePresetId === 'string') state.selectedPipelinePresetId = source.selectedPipelinePresetId;
    if (typeof source.selectedStepId === 'string') state.selectedStepId = source.selectedStepId;
    if (typeof source.mode === 'string') state.mode = source.mode;
    if (source.characterStep && typeof source.characterStep === 'object') {
      const incoming = source.characterStep;
      state.characterStep = {
        ...state.characterStep,
        ...incoming,
        dropSlots: Array.isArray(incoming.dropSlots) ? incoming.dropSlots.slice(0, 3) : state.characterStep.dropSlots,
        characters: Array.isArray(incoming.characters) ? incoming.characters : state.characterStep.characters,
      };
    }
    if (source.storyStep && typeof source.storyStep === 'object') {
      const incoming = source.storyStep;
      state.storyStep = {
        ...state.storyStep,
        ...incoming,
        generatedOutline: Array.isArray(incoming.generatedOutline) ? incoming.generatedOutline.slice(0, 8) : state.storyStep.generatedOutline,
      };
    }
    if (source.musicStep && typeof source.musicStep === 'object') {
      const incoming = source.musicStep;
      state.musicStep = {
        ...state.musicStep,
        ...incoming,
      };
    }
    if (source.sceneImageStep && typeof source.sceneImageStep === 'object') {
      const incoming = source.sceneImageStep;
      state.sceneImageStep = {
        ...state.sceneImageStep,
        ...incoming,
        scenePrompts: Array.isArray(incoming.scenePrompts) ? incoming.scenePrompts.slice(0, MAX_SCENE_COUNT) : state.sceneImageStep.scenePrompts,
      };
    }
    if (source.sceneVideoStep && typeof source.sceneVideoStep === 'object') {
      const incoming = source.sceneVideoStep;
      state.sceneVideoStep = {
        ...state.sceneVideoStep,
        ...incoming,
        sceneVideos: Array.isArray(incoming.sceneVideos) ? incoming.sceneVideos.slice(0, MAX_SCENE_COUNT) : state.sceneVideoStep.sceneVideos,
      };
    }
    if (source.finalMvStep && typeof source.finalMvStep === 'object') {
      const incoming = source.finalMvStep;
      state.finalMvStep = {
        ...state.finalMvStep,
        ...incoming,
      };
    }
    if (source.canvas && typeof source.canvas === 'object') {
      state.canvas = {
        id: String(source.canvas.id || state.canvas.id || ''),
        name: String(source.canvas.name || state.canvas.name || ''),
        createdAt: source.canvas.createdAt || state.canvas.createdAt || null,
        updatedAt: source.canvas.updatedAt || state.canvas.updatedAt || null,
      };
    }
    if (source.lastSavedAt) state.lastSavedAt = source.lastSavedAt;
  }

  async function loadConfig() {
    const response = await fetch('/api/v1/production/config', { cache: 'no-store' });
    if (!response.ok) throw new Error(`config load failed: ${response.status}`);
    const data = await response.json();
    state.config = data;
  }

  async function hydrateState() {
    try {
      const local = localStorage.getItem(STORAGE_KEY);
      if (local) mergeState(JSON.parse(local));
    } catch (_error) {
      // noop
    }

    try {
      const response = await fetch(`/api/v1/production/state?client_session_id=${encodeURIComponent(getSessionId())}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`state load failed: ${response.status}`);
      const data = await response.json();
      if (data?.state && typeof data.state === 'object') {
        mergeState(data.state);
        state.lastSavedAt = normalizeTimestamp(data.updated_at) || state.lastSavedAt;
      }
    } catch (_error) {
      // noop
    }
  }

  function ensureUsableState() {
    const presets = Array.isArray(state.config?.presets) ? state.config.presets : [];
    if (!presets.length) return;

    if (!state.selectedPresetId || !getPresetById(state.selectedPresetId)) {
      state.selectedPresetId = String(presets[0].id);
    }

    const preset = getPresetById();
    if (!state.mode || !getModeMeta(state.mode)) {
      state.mode = String(preset?.recommended_mode || 'new');
    }

    const pipelineExists = getPipelineOptionsForPreset(preset).some((item) => String(item.id) === String(state.selectedPipelinePresetId));
    if (!pipelineExists) {
      state.selectedPipelinePresetId = defaultPipelinePresetIdForPreset(preset);
    }

    const stepExists = preset?.steps?.some((step) => String(step.id) === String(state.selectedStepId));
    if (!stepExists) {
      state.selectedStepId = defaultStepIdForPreset(preset);
    }

    if (!state.canvas.id) {
      state.canvas.id = crypto?.randomUUID?.() || `canvas-${Date.now()}`;
    }
    if (!state.canvas.createdAt) {
      state.canvas.createdAt = Date.now();
    }
    if (!String(state.canvas.name || '').trim()) {
      state.canvas.name = createCanvasName(preset?.name || '新規キャンバス');
    }
    if (!state.canvas.updatedAt) {
      state.canvas.updatedAt = state.lastSavedAt || Date.now();
    }

    if (!state.characterStep || typeof state.characterStep !== 'object') {
      state.characterStep = {
        dropSlots: [null, null, null],
        ref3ModeEnabled: true,
        ref3UseMode: 'background',
        characters: [],
        selectedCharacterToken: '',
        imagePrompt: '',
        keyImageAnalysis: '',
        keyImageAnalysisRaw: null,
        characterImage: null,
        characterSheetImage: null,
        charSheetNobg: false,
        notice: null,
      };
    }

    if (!Array.isArray(state.characterStep.dropSlots)) {
      state.characterStep.dropSlots = [null, null, null];
    }
    while (state.characterStep.dropSlots.length < 3) {
      state.characterStep.dropSlots.push(null);
    }
    state.characterStep.dropSlots = state.characterStep.dropSlots.slice(0, 3);
    if (!Array.isArray(state.characterStep.characters)) {
      state.characterStep.characters = [];
    }
    state.characterStep.ref3UseMode = String(state.characterStep.ref3UseMode || 'background');
    state.characterStep.selectedCharacterToken = String(state.characterStep.selectedCharacterToken || '');
    state.characterStep.imagePrompt = String(state.characterStep.imagePrompt || '');
    state.characterStep.keyImageAnalysis = String(state.characterStep.keyImageAnalysis || '');

    if (!state.sceneImageStep || typeof state.sceneImageStep !== 'object') {
      state.sceneImageStep = {
        scenePrompts: [],
        selectedSceneIndex: 0,
        useStoryContext: true,
        useMusicContext: true,
        useCharacterContext: true,
        cfg: 1.0,
        denoise: 1.0,
        notice: null,
        lastPromptGeneratedAt: null,
      };
    }
    if (!Array.isArray(state.sceneImageStep.scenePrompts)) {
      state.sceneImageStep.scenePrompts = [];
    }
    state.sceneImageStep.scenePrompts = state.sceneImageStep.scenePrompts.slice(0, MAX_SCENE_COUNT).map((item, index) => ({
      sceneIndex: Math.max(1, Number(item?.sceneIndex || item?.scene_index || index + 1) || index + 1),
      prompt: String(item?.prompt || ''),
      durationSec: Math.max(1, Number(item?.durationSec || item?.duration_sec || 0) || 0),
      lyricExcerpt: String(item?.lyricExcerpt || item?.lyric_excerpt || ''),
      transitionType: normalizeSceneTransitionType(item?.transitionType || item?.transition_type || 'none', { sceneIndex: index + 1 }),
      transitionReason: normalizeSceneTransitionReason(item?.transitionReason || item?.transition_reason || ''),
      image: item?.image && typeof item.image === 'object' ? { ...item.image } : null,
    }));
    state.sceneImageStep.selectedSceneIndex = Math.max(0, Number(state.sceneImageStep.selectedSceneIndex || 0) || 0);

    if (!state.sceneVideoStep || typeof state.sceneVideoStep !== 'object') {
      state.sceneVideoStep = {
        sceneVideos: [],
        selectedSceneIndex: 0,
        useScenePrompt: true,
        useMusicContext: true,
        audioOff: false,
        fps: 25,
        workflowMode: '',
        notice: null,
        lastGeneratedAt: null,
      };
    }
    if (!Array.isArray(state.sceneVideoStep.sceneVideos)) {
      state.sceneVideoStep.sceneVideos = [];
    }
    state.sceneVideoStep.sceneVideos = state.sceneVideoStep.sceneVideos.slice(0, MAX_SCENE_COUNT).map((item, index) => ({
      sceneIndex: Math.max(1, Number(item?.sceneIndex || item?.scene_index || index + 1) || index + 1),
      prompt: String(item?.prompt || ''),
      promptCustomized: !!item?.promptCustomized,
      durationSec: Math.max(1, Number(item?.durationSec || item?.duration_sec || 0) || 0),
      image: item?.image && typeof item.image === 'object' ? { ...item.image } : null,
      lyricExcerpt: String(item?.lyricExcerpt || item?.lyric_excerpt || ''),
      transitionType: normalizeSceneTransitionType(item?.transitionType || item?.transition_type || 'none', { sceneIndex: index + 1 }),
      transitionReason: normalizeSceneTransitionReason(item?.transitionReason || item?.transition_reason || ''),
      video: item?.video && typeof item.video === 'object' ? { ...item.video } : null,
    }));
    state.sceneVideoStep.selectedSceneIndex = Math.max(0, Number(state.sceneVideoStep.selectedSceneIndex || 0) || 0);
    state.sceneVideoStep.workflowMode = String(state.sceneVideoStep.workflowMode || '');
    if (state.sceneVideoStep.workflowMode.trim().toLowerCase() === 'auto') {
      state.sceneVideoStep.workflowMode = '';
    }
    state.sceneVideoStep.audioOff = !!state.sceneVideoStep.audioOff;
    state.sceneVideoStep.fps = Math.max(8, Math.min(32, Number(state.sceneVideoStep.fps) || getDefaultSceneVideoFps(state.sceneVideoStep.workflowMode)));

    if (!state.finalMvStep || typeof state.finalMvStep !== 'object') {
      state.finalMvStep = {
        clipVideo: null,
        finalVideo: null,
        notice: null,
        lastRenderedAt: null,
      };
    }
    state.finalMvStep.clipVideo = normalizeFinalMvMediaItem(state.finalMvStep.clipVideo);
    state.finalMvStep.finalVideo = normalizeFinalMvMediaItem(state.finalMvStep.finalVideo);
  }

  function getCharacterStepState() {
    return state.characterStep;
  }

  function setCharacterNotice(message, tone = 'info') {
    state.characterStep.notice = message ? { message: String(message), tone: String(tone || 'info') } : null;
  }

  function getPrimaryCharacterReference() {
    const characterState = getCharacterStepState();
    return characterState.dropSlots.find(Boolean) || null;
  }

  function getCharacterAnalysisTarget() {
    const characterState = getCharacterStepState();
    if (characterState.characterSheetImage?.previewUrl) {
      return {
        previewUrl: characterState.characterSheetImage.previewUrl,
        originalName: characterState.characterSheetImage.filename || 'キャラシート',
        source: 'characterSheetImage',
      };
    }
    if (characterState.characterImage?.previewUrl) {
      return {
        previewUrl: characterState.characterImage.previewUrl,
        originalName: characterState.characterImage.filename || 'キャラ合成画像',
        source: 'characterImage',
      };
    }
    const primaryRef = getPrimaryCharacterReference();
    if (primaryRef?.previewUrl) {
      return {
        previewUrl: primaryRef.previewUrl,
        originalName: primaryRef.originalName || primaryRef.filename || 'ref1',
        source: 'ref',
      };
    }
    return null;
  }

  function showCharacterImageReferenceDialog() {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;';
      const box = document.createElement('div');
      box.style.cssText = 'background:#1e1e2e;color:#e0e0e0;border-radius:10px;padding:24px 28px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.5);font-family:inherit;';
      box.innerHTML = `
        <div style="font-size:15px;font-weight:600;margin-bottom:12px;">🖼️ キャラ合成画像の参照確認</div>
        <div style="font-size:13px;line-height:1.6;margin-bottom:18px;">
          現在キャラ合成画像が設定されています。<br>
          新しいキャラ合成画像の生成で現在の画像を参照しますか？<br>
          <span style="color:#aaa;font-size:12px;">（参照すると I2I Edit として生成されます）</span>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
          <button id="_characterImageRefDlgCancel" style="padding:7px 16px;border-radius:6px;border:1px solid #555;background:#333;color:#ccc;cursor:pointer;font-size:13px;">キャンセル</button>
          <button id="_characterImageRefDlgClear" style="padding:7px 16px;border-radius:6px;border:1px solid #e8a735;background:#4a3a10;color:#f0d060;cursor:pointer;font-size:13px;">参照せず生成（現在画像クリア）</button>
          <button id="_characterImageRefDlgRef" style="padding:7px 16px;border-radius:6px;border:none;background:#2563eb;color:#fff;cursor:pointer;font-size:13px;font-weight:600;">参照して生成</button>
        </div>`;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const cleanup = () => { overlay.remove(); };
      box.querySelector('#_characterImageRefDlgRef').addEventListener('click', () => { cleanup(); resolve('reference'); });
      box.querySelector('#_characterImageRefDlgClear').addEventListener('click', () => { cleanup(); resolve('clear'); });
      box.querySelector('#_characterImageRefDlgCancel').addEventListener('click', () => { cleanup(); resolve('cancel'); });
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
          cleanup();
          resolve('cancel');
        }
      });
    });
  }

  async function refreshCharacterRegistry({ rerender = true } = {}) {
    try {
      const response = await fetch(`/api/v1/production/ref-images?client_session_id=${encodeURIComponent(getSessionId())}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.characterStep.characters = Array.isArray(data?.items) ? data.items : [];
      if (rerender && getCurrentStep()?.id === 'character') renderDetail();
    } catch (_error) {
      state.characterStep.characters = [];
      if (rerender && getCurrentStep()?.id === 'character') renderDetail();
    }
  }

  function renderSaveStatus(message, saved) {
    if (!els.resumeStatus) return;
    els.resumeStatus.textContent = message;
    els.resumeStatus.style.background = saved
      ? 'rgba(52, 211, 153, 0.16)'
      : 'rgba(59, 130, 246, 0.15)';
    els.resumeStatus.style.borderColor = saved
      ? 'rgba(52, 211, 153, 0.28)'
      : 'rgba(110, 168, 254, 0.28)';
    els.resumeStatus.style.color = saved ? '#d1fae5' : '#dbeafe';
  }

  function renderCanvasSummary() {
    const preset = getPresetById();
    const step = getCurrentStep();
    const mode = getModeMeta();
    const pipeline = getSelectedPipelineOption(preset);

    els.canvasTitle.textContent = state.canvas.name || '新しいキャンバス';
    els.canvasNameInput.value = state.canvas.name || '';
    els.canvasUpdatedAt.textContent = `最終保存: ${formatDateTime(state.lastSavedAt || state.canvas.updatedAt)}`;
    els.summaryPreset.textContent = preset?.name || '未選択';
    els.summaryMode.textContent = pipeline?.label || mode?.label || '未選択';
    els.summaryStep.textContent = step?.title || '未選択';
    els.summaryHint.textContent = step?.handoff || 'プリセットを選択してください';
    renderSaveStatus(state.lastSavedAt ? '前回のキャンバスを保持中' : 'ローカル保持中', !!state.lastSavedAt);
  }

  function renderPresetOptions() {
    const presets = state.config?.presets || [];
    els.presetSelect.innerHTML = presets
      .map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)} / ${escapeHtml(preset.tagline)}</option>`)
      .join('');
    els.presetSelect.value = state.selectedPresetId;
  }

  function getModeSwitchMarkup() {
    const modes = state.config?.modes || [];
    return modes.map((mode) => {
      const active = String(mode.id) === String(state.mode);
      return `
        <button class="mode-chip ${active ? 'active' : ''}" data-mode-id="${escapeHtml(mode.id)}" type="button">
          <span class="mode-chip-title">${escapeHtml(mode.label)}</span>
          <span class="mode-chip-desc">${escapeHtml(mode.description)}</span>
        </button>
      `;
    }).join('');
  }

  function renderPresetOverview() {
    const preset = getPresetById();
    if (!preset) {
      els.presetOverview.innerHTML = '';
      return;
    }

    const flowSummaryText = (preset.flow_summary || []).join(' / ');
    const pipelineOptions = getPipelineOptionsForPreset(preset);
    const selectedPipeline = getSelectedPipelineOption(preset);

    els.presetOverview.innerHTML = `
      <div class="preset-headline">
        <div class="preset-main">
          <div class="preset-type-badge"><span>制作タイプ</span><strong>${escapeHtml(preset.name || '')}</strong></div>
          <p class="preset-description">
            ${escapeHtml(preset.description || '')}
            ${flowSummaryText ? `<strong class="preset-summary-inline">${escapeHtml(flowSummaryText)}</strong>` : ''}
          </p>
          <div class="preset-controls-inline">
            ${pipelineOptions.length ? `
              <div class="pipeline-selector">
                <div class="field-label pipeline-selector-label">制作フロープラン選択</div>
                <select id="pipelineSelect" class="select-input pipeline-select-input">
                  ${pipelineOptions.map((option) => `
                    <option value="${escapeHtml(option.id)}" ${String(option.id) === String(state.selectedPipelinePresetId) ? 'selected' : ''}>${escapeHtml(option.label || option.id)}</option>
                  `).join('')}
                </select>
                ${selectedPipeline?.description ? `<p class="pipeline-select-description">${escapeHtml(selectedPipeline.description)}</p>` : ''}
              </div>
            ` : '<div></div>'}
            <div class="preset-mode-inline">
              <div class="field-label">作業</div>
              <div class="mode-switch" id="modeSwitch">${getModeSwitchMarkup()}</div>
            </div>
          </div>
        </div>
          <div>
            <div class="flow-mini-badge">推奨: ${escapeHtml(getModeMeta(preset.recommended_mode)?.label || '自動制作')}</div>
            ${selectedPipeline ? `<div class="pipeline-selected-note"><span>制作実行プラン</span><strong>${escapeHtml(selectedPipeline.label || '')}</strong></div>` : ''}
        </div>
      </div>
    `;
  }

  function getFlowCardAccent(step, index = 0) {
    const palette = [
      { color: '#60a5fa', rgb: '96, 165, 250' },
      { color: '#a78bfa', rgb: '167, 139, 250' },
      { color: '#34d399', rgb: '52, 211, 153' },
      { color: '#f59e0b', rgb: '245, 158, 11' },
      { color: '#f472b6', rgb: '244, 114, 182' },
      { color: '#22d3ee', rgb: '34, 211, 238' },
      { color: '#fb7185', rgb: '251, 113, 133' },
      { color: '#a3e635', rgb: '163, 230, 53' },
    ];
    const stepKey = String(step?.id || '').trim();
    const hashed = stepKey
      ? Array.from(stepKey).reduce((sum, char) => sum + char.charCodeAt(0), 0)
      : index;
    return palette[hashed % palette.length];
  }

  function renderFlowPreview() {
    const preset = getPresetById();
    if (!preset) {
      els.flowPreview.innerHTML = '';
      return;
    }
    els.flowPreview.innerHTML = preset.steps.map((step, index) => {
      const active = String(step.id) === String(state.selectedStepId);
      const accent = getFlowCardAccent(step, index);
      return `
        <button
          class="flow-card ${active ? 'active' : ''}"
          data-step-id="${escapeHtml(step.id)}"
          style="--flow-card-accent: ${escapeHtml(accent.color)}; --flow-card-accent-rgb: ${escapeHtml(accent.rgb)};"
          type="button"
        >
          <span class="flow-index">${index + 1}</span>
          <h3>${escapeHtml(step.title)}</h3>
          <p class="step-card-copy">${escapeHtml(step.short || '')}</p>
        </button>
      `;
    }).join('');
  }

  function renderDetailStepSummary(step) {
    if (!els.detailStepSummary) {
      return;
    }

    if (!step) {
      els.detailStepSummary.innerHTML = '';
      els.detailStepSummary.hidden = true;
      return;
    }

    const outputs = (step.outputs || []).length ? (step.outputs || []).join(' / ') : 'このSTEPで定義された出力をここに表示します';
    const handoff = step.handoff || '次STEPへの受け渡し情報をここに表示します';
    const summaryPoints = (step.summary_points || []).length ? (step.summary_points || []).join(' / ') : (step.objective || 'このSTEPの目的を整理します');

    els.detailStepSummary.innerHTML = `
      <div class="detail-step-summary-card">
        <div class="detail-step-summary-head">
          <span class="step-chip">選択中STEPの概要</span>
          <span class="flow-mini-badge">${escapeHtml(step.short || step.title || '')}</span>
        </div>
        <p class="detail-step-summary-copy">${escapeHtml(step.objective || '')}</p>
        <ul class="detail-step-meta">
          <li>
            <strong>要点</strong>
            <span>${escapeHtml(summaryPoints)}</span>
          </li>
          <li>
            <strong>主な出力</strong>
            <span>${escapeHtml(outputs)}</span>
          </li>
          <li>
            <strong>次STEPへの受け渡し</strong>
            <span>${escapeHtml(handoff)}</span>
          </li>
        </ul>
      </div>
    `;
    els.detailStepSummary.hidden = false;
  }

  function parseVLMOutput(rawOutput) {
    let prompt = '';
    let negativePrompt = '';
    let text = String(rawOutput || '');
    const promptMarkers = [/\*\*Prompt:\*\*/i, /\*\*Image Generation Prompt:\*\*/i, /\*\*Generated Prompt:\*\*/i, /Prompt:/i];
    const negativeMarkers = [/\*\*Negative Prompt:\*\*/i, /Negative Prompt:/i, /Negative:/i];

    for (const marker of promptMarkers) {
      const match = text.match(marker);
      if (match) {
        const index = text.indexOf(match[0]);
        text = text.substring(index + match[0].length).trim();
        break;
      }
    }

    for (const marker of negativeMarkers) {
      const match = text.match(marker);
      if (match) {
        const index = text.indexOf(match[0]);
        prompt = text.substring(0, index).trim();
        negativePrompt = text.substring(index + match[0].length).trim();
        break;
      }
    }

    if (!negativePrompt) prompt = text.trim();
    return { prompt, negativePrompt };
  }

  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result || '');
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function detectTranslationTargetLanguage(text) {
    const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(String(text || ''));
    return {
      targetLangLabel: hasJapanese ? 'English' : '日本語',
      targetLanguageParam: hasJapanese ? 'en' : 'ja',
    };
  }

  async function translateProductionText({ text, button, emptyMessage }) {
    const sourceText = String(text || '').trim();
    if (!sourceText) {
      throw new Error(emptyMessage || '翻訳するテキストがありません');
    }

    const { targetLangLabel, targetLanguageParam } = detectTranslationTargetLanguage(sourceText);

    if (button) {
      button.disabled = true;
      button.textContent = '🔄...';
    }

    try {
      const response = await fetch('/api/v1/production/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sourceText, target_language: targetLanguageParam }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      const translated = String(result?.translated_text || '').trim();
      if (!translated) {
        throw new Error('翻訳結果が空です');
      }
      return { translated, targetLangLabel };
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = '🌐 翻訳';
      }
    }
  }

  async function translateCharacterPrompt() {
    const input = els.detailBody.querySelector('#characterPromptInput');
    const button = els.detailBody.querySelector('#characterPromptTranslateBtn');
    const { translated, targetLangLabel } = await translateProductionText({
      text: input?.value || '',
      button,
      emptyMessage: '翻訳するキャラ合成プロンプトがありません',
    });

    state.characterStep.imagePrompt = translated;
    state.characterStep.characterImage = null;
    state.canvas.updatedAt = Date.now();
    setCharacterNotice(`${targetLangLabel}に翻訳しました`, 'success');
    renderDetail();
    scheduleSave();
  }

  async function translateCharacterAnalysis() {
    const input = els.detailBody.querySelector('#characterAnalysisText');
    const button = els.detailBody.querySelector('#characterAnalysisTranslateBtn');
    const { translated, targetLangLabel } = await translateProductionText({
      text: input?.value || '',
      button,
      emptyMessage: '翻訳する解析結果がありません',
    });

    state.characterStep.keyImageAnalysis = translated;
    state.canvas.updatedAt = Date.now();
    setCharacterNotice(`${targetLangLabel}に翻訳しました`, 'success');
    renderDetail();
    scheduleSave();
  }

  function getStoryStepState() {
    return state.storyStep;
  }

  function setStoryNotice(message, tone = 'info') {
    state.storyStep.notice = message ? { message: String(message), tone: String(tone || 'info') } : null;
  }

  function getStoryCharacterContext() {
    const characterState = getCharacterStepState();
    const parts = [];
    if (characterState.selectedCharacterToken) {
      parts.push(`selected_character: ${characterState.selectedCharacterToken}`);
    }
    if (characterState.keyImageAnalysis) {
      parts.push(characterState.keyImageAnalysis);
    }
    if (characterState.imagePrompt) {
      parts.push(`character_prompt: ${characterState.imagePrompt}`);
    }
    return parts.filter(Boolean).join('\n\n').trim();
  }

  function buildStoryOutline(text, sceneCount = 5) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const parts = raw
      .split(/\n+|(?<=[。.!?！？])\s+/)
      .map((item) => String(item || '').replace(/^[-・\d.\s]+/, '').trim())
      .filter(Boolean);
    return parts.slice(0, Math.max(1, Math.min(Number(sceneCount) || 5, 8)));
  }

  async function generateStoryScenario() {
    const storyState = getStoryStepState();
    const idea = String(storyState.idea || '').trim();
    if (!idea) {
      setStoryNotice('ざっくり意図を入力してください', 'warning');
      renderDetail();
      return;
    }

    if (storyGenerationBusy) {
      return;
    }

    storyGenerationBusy = true;
    setStoryNotice('シナリオ・世界観を生成中です...', 'info');
    renderDetail();

    try {
      const characterContext = storyState.useCharacterContext ? getStoryCharacterContext() : '';
      const response = await fetch('/api/v1/production/story/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idea,
          character_context: characterContext,
          world_notes: String(storyState.worldNotes || ''),
          genre: String(storyState.genre || ''),
          scene_count: Math.max(1, Number(storyState.sceneCount) || 5),
          target_duration_sec: Math.max(10, Number(storyState.targetDurationSec) || 30),
          lyrics_enabled: !!storyState.lyricsEnabled,
          language: 'ja',
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      const scenarioText = String(result?.scenario_text || '').trim();
      if (!scenarioText) {
        throw new Error('シナリオ生成結果が空です');
      }

      state.storyStep.scenarioText = scenarioText;
      state.storyStep.worldNotes = String(result?.world_notes || state.storyStep.worldNotes || '');
      state.storyStep.generatedOutline = [];
      state.storyStep.lastGeneratedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setStoryNotice('シナリオ・世界観を生成しました', 'success');
      renderDetail();
      scheduleSave();
    } finally {
      storyGenerationBusy = false;
      renderDetail();
    }
  }

  async function translateStoryField(fieldName, emptyMessage) {
    const input = els.detailBody.querySelector(`[data-story-field="${fieldName}"]`);
    const button = els.detailBody.querySelector(`[data-story-translate="${fieldName}"]`);
    const { translated, targetLangLabel } = await translateProductionText({
      text: input?.value || '',
      button,
      emptyMessage,
    });

    if (fieldName === 'scenarioText') {
      state.storyStep.scenarioText = translated;
      state.storyStep.generatedOutline = [];
    } else if (fieldName === 'idea') {
      state.storyStep.idea = translated;
    } else if (fieldName === 'worldNotes') {
      state.storyStep.worldNotes = translated;
    }
    state.canvas.updatedAt = Date.now();
    setStoryNotice(`${targetLangLabel}に翻訳しました`, 'success');
    renderDetail();
    scheduleSave();
  }

  function applyCharacterContextToStoryNotes() {
    const context = getStoryCharacterContext();
    if (!context) {
      setStoryNotice('先にキャラクタ作成エリアで解析結果やキャラ情報を用意してください', 'warning');
      renderDetail();
      return;
    }
    const current = String(state.storyStep.worldNotes || '').trim();
    const merged = current ? `${current}\n\n${context}` : context;
    state.storyStep.worldNotes = merged;
    state.storyStep.useCharacterContext = true;
    state.canvas.updatedAt = Date.now();
    setStoryNotice('キャラクタ作成エリアの情報を世界観メモへ反映しました', 'success');
    renderDetail();
    scheduleSave();
  }

  function clearStoryScenario() {
    state.storyStep.scenarioText = '';
    state.storyStep.generatedOutline = [];
    state.storyStep.lastGeneratedAt = null;
    state.canvas.updatedAt = Date.now();
    setStoryNotice('シナリオ・世界観をクリアしました', 'info');
    renderDetail();
    scheduleSave();
  }

  function getMusicStepState() {
    return state.musicStep;
  }

  function getEffectiveMusicDurationSec() {
    const override = Number(state.musicStep.durationOverrideSec || 0);
    if (override > 0) {
      return Math.max(10, Math.min(600, override));
    }
    return Math.max(10, Number(state.storyStep.targetDurationSec) || 30);
  }

  function hasMusicDurationOverride() {
    return Number(state.musicStep.durationOverrideSec || 0) > 0;
  }

  function getCurrentMusicAudioDurationSec() {
    const stored = Math.max(0, Number(state.musicStep.generatedAudio?.durationSec || 0) || 0);
    if (stored > 0) return stored;
    const audio = els.detailBody?.querySelector('#musicAudioPlayer');
    return Math.max(0, Number(audio?.duration || 0) || 0);
  }

  function getMusicAudioTrimRange() {
    const audio = state.musicStep.generatedAudio;
    const durationSec = getCurrentMusicAudioDurationSec();
    const rawStart = Number(audio?.trimStartSec);
    const rawEnd = Number(audio?.trimEndSec);
    const startSec = Math.max(0, Math.min(durationSec, Number.isFinite(rawStart) ? rawStart : 0));
    let endSec = Number.isFinite(rawEnd) && rawEnd > 0 ? rawEnd : durationSec;
    endSec = Math.max(0, Math.min(durationSec, endSec));
    if (endSec <= startSec) {
      endSec = durationSec > startSec ? durationSec : startSec;
    }
    return {
      startSec: Number(startSec.toFixed(2)),
      endSec: Number(endSec.toFixed(2)),
      keepDurationSec: Number(Math.max(0, endSec - startSec).toFixed(2)),
      durationSec: Number(durationSec.toFixed(2)),
    };
  }

  function setMusicAudioTrimRange(startSec, endSec) {
    const audio = state.musicStep.generatedAudio;
    if (!audio || typeof audio !== 'object') return;
    const durationSec = Math.max(0, Number(audio.durationSec || 0) || 0);
    const safeStart = Math.max(0, Math.min(durationSec, Number(startSec) || 0));
    let safeEnd = Number(endSec);
    safeEnd = Number.isFinite(safeEnd) && safeEnd > 0 ? safeEnd : durationSec;
    safeEnd = Math.max(0, Math.min(durationSec, safeEnd));
    if (safeEnd <= safeStart) {
      safeEnd = durationSec > safeStart ? durationSec : safeStart;
    }
    audio.trimStartSec = Number(safeStart.toFixed(2));
    audio.trimEndSec = Number(safeEnd.toFixed(2));
  }

  function getMusicWaveformCacheKey() {
    return String(state.musicStep.generatedAudio?.previewUrl || '').trim();
  }

  function buildMusicWaveformPeaks(audioBuffer, targetBars = 320) {
    const barCount = Math.max(48, Math.min(Number(targetBars) || 320, 480));
    const channelCount = Math.max(1, Number(audioBuffer?.numberOfChannels) || 1);
    const totalSamples = Math.max(1, Number(audioBuffer?.length) || 1);
    const blockSize = Math.max(1, Math.floor(totalSamples / barCount));
    const peaks = [];
    for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
      const start = barIndex * blockSize;
      const end = barIndex === barCount - 1 ? totalSamples : Math.min(totalSamples, start + blockSize);
      let peak = 0;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const channelData = audioBuffer.getChannelData(channelIndex);
        for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
          const amplitude = Math.abs(channelData[sampleIndex] || 0);
          if (amplitude > peak) peak = amplitude;
        }
      }
      peaks.push(Math.max(0.02, Math.min(1, peak)));
    }
    return peaks;
  }

  async function loadMusicWaveformData(previewUrl) {
    const cacheKey = String(previewUrl || '').trim();
    if (!cacheKey) {
      throw new Error('audio preview url is required');
    }
    const cached = musicWaveformCache.get(cacheKey);
    if (cached?.status === 'ready' && cached.data) {
      return cached.data;
    }
    if (cached?.promise) {
      return cached.promise;
    }

    const promise = (async () => {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error('AudioContext is not available');
      }
      const response = await fetch(cacheKey, { cache: 'force-cache' });
      if (!response.ok) {
        throw new Error(`waveform fetch failed: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const audioContext = new AudioContextClass();
      try {
        const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        return {
          peaks: buildMusicWaveformPeaks(decoded),
          durationSec: Math.max(0, Number(decoded.duration) || 0),
        };
      } finally {
        try {
          await audioContext.close();
        } catch (_error) {
          // noop
        }
      }
    })();

    musicWaveformCache.set(cacheKey, { status: 'loading', promise });
    try {
      const data = await promise;
      musicWaveformCache.set(cacheKey, { status: 'ready', data });
      return data;
    } catch (error) {
      musicWaveformCache.set(cacheKey, { status: 'error', error });
      throw error;
    }
  }

  function drawMusicWaveformCanvas(canvas, waveformData, trimRange) {
    if (!(canvas instanceof HTMLCanvasElement) || !waveformData?.peaks?.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cssWidth = Math.max(1, Math.round(canvas.clientWidth || 0));
    const cssHeight = Math.max(1, Math.round(canvas.clientHeight || 0));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    if (canvas.width !== cssWidth * dpr || canvas.height !== cssHeight * dpr) {
      canvas.width = cssWidth * dpr;
      canvas.height = cssHeight * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const durationSec = Math.max(0.01, Number(trimRange?.durationSec || waveformData.durationSec || 0.01));
    const startRatio = Math.max(0, Math.min(1, Number(trimRange?.startSec || 0) / durationSec));
    const endRatio = Math.max(startRatio, Math.min(1, Number(trimRange?.endSec || durationSec) / durationSec));
    const selectedStartX = Math.round(cssWidth * startRatio);
    const selectedEndX = Math.round(cssWidth * endRatio);
    const centerY = cssHeight / 2;
    const peaks = waveformData.peaks;
    const barWidth = cssWidth / peaks.length;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.16)';
    ctx.fillRect(selectedStartX, 0, Math.max(2, selectedEndX - selectedStartX), cssHeight);
    ctx.fillStyle = 'rgba(2, 6, 23, 0.48)';
    ctx.fillRect(0, 0, selectedStartX, cssHeight);
    ctx.fillRect(selectedEndX, 0, Math.max(0, cssWidth - selectedEndX), cssHeight);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, centerY);
    ctx.lineTo(cssWidth, centerY);
    ctx.stroke();

    peaks.forEach((peak, index) => {
      const x = index * barWidth;
      const amplitude = Math.max(2, peak * (cssHeight * 0.44));
      const isSelected = x + barWidth >= selectedStartX && x <= selectedEndX;
      ctx.fillStyle = isSelected ? 'rgba(96, 165, 250, 0.95)' : 'rgba(148, 163, 184, 0.58)';
      ctx.fillRect(x, centerY - amplitude, Math.max(1, barWidth - 1), amplitude * 2);
    });

    ctx.strokeStyle = 'rgba(248, 250, 252, 0.92)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(selectedStartX, 0);
    ctx.lineTo(selectedStartX, cssHeight);
    ctx.moveTo(selectedEndX, 0);
    ctx.lineTo(selectedEndX, cssHeight);
    ctx.stroke();
  }

  function getMusicWaveformPlaybackState() {
    const audio = els.detailBody?.querySelector('#musicAudioPlayer');
    if (!(audio instanceof HTMLAudioElement)) {
      return {
        currentTimeSec: 0,
        durationSec: 0,
        playing: false,
      };
    }
    return {
      currentTimeSec: Math.max(0, Number(audio.currentTime) || 0),
      durationSec: Math.max(0, Number(audio.duration) || 0),
      playing: !audio.paused && !audio.ended,
    };
  }

  function stopMusicWaveformPlaybackLoop() {
    if (musicWaveformPlaybackRafId) {
      window.cancelAnimationFrame(musicWaveformPlaybackRafId);
      musicWaveformPlaybackRafId = 0;
    }
  }

  function startMusicWaveformPlaybackLoop() {
    stopMusicWaveformPlaybackLoop();
    const tick = () => {
      const playback = getMusicWaveformPlaybackState();
      renderMusicWaveformPreview();
      if (playback.playing) {
        musicWaveformPlaybackRafId = window.requestAnimationFrame(tick);
      } else {
        musicWaveformPlaybackRafId = 0;
      }
    };
    musicWaveformPlaybackRafId = window.requestAnimationFrame(tick);
  }

  function syncMusicTrimInputsFromState() {
    const trimRange = getMusicAudioTrimRange();
    const startInput = els.detailBody?.querySelector('#musicTrimStartInput');
    const endInput = els.detailBody?.querySelector('#musicTrimEndInput');
    const startRange = els.detailBody?.querySelector('#musicTrimStartRange');
    const endRange = els.detailBody?.querySelector('#musicTrimEndRange');
    const summary = els.detailBody?.querySelector('#musicTrimSummary');
    const playbackStatus = els.detailBody?.querySelector('#musicTrimPlaybackStatus');
    const durationValue = trimRange.durationSec.toFixed(1);
    const startValue = trimRange.startSec.toFixed(1);
    const endValue = trimRange.endSec.toFixed(1);
    const playback = getMusicWaveformPlaybackState();
    if (startInput) {
      startInput.max = durationValue;
      startInput.value = startValue;
    }
    if (endInput) {
      endInput.max = durationValue;
      endInput.value = endValue;
    }
    if (startRange) {
      startRange.max = durationValue;
      startRange.value = startValue;
    }
    if (endRange) {
      endRange.max = durationValue;
      endRange.value = endValue;
    }
    if (summary) {
      summary.textContent = `元音声 ${durationValue} 秒 / 採用区間 ${trimRange.keepDurationSec.toFixed(1)} 秒。不要部分を削って、今の音声を短くできます。`;
    }
    if (playbackStatus) {
      playbackStatus.textContent = `再生位置 ${playback.currentTimeSec.toFixed(1)} / ${(playback.durationSec || trimRange.durationSec).toFixed(1)} 秒`;
    }
  }

  function renderMusicWaveformPreview() {
    const canvas = els.detailBody?.querySelector('#musicTrimWaveformCanvas');
    const empty = els.detailBody?.querySelector('#musicTrimWaveformEmpty');
    if (!(canvas instanceof HTMLCanvasElement)) return;
    syncMusicTrimInputsFromState();
    const cacheKey = getMusicWaveformCacheKey();
    const cached = musicWaveformCache.get(cacheKey);
    if (cached?.status === 'ready' && cached.data) {
      if (empty) {
        empty.hidden = true;
      }
      drawMusicWaveformCanvas(canvas, cached.data, getMusicAudioTrimRange());
      const playback = getMusicWaveformPlaybackState();
      const ctx = canvas.getContext('2d');
      const cssWidth = Math.max(1, Math.round(canvas.clientWidth || 0));
      const cssHeight = Math.max(1, Math.round(canvas.clientHeight || 0));
      if (ctx) {
        const durationSec = Math.max(0.01, Number(playback.durationSec || cached.data.durationSec || getMusicAudioTrimRange().durationSec || 0.01));
        const playbackRatio = Math.max(0, Math.min(1, Number(playback.currentTimeSec || 0) / durationSec));
        const playheadX = Math.round(cssWidth * playbackRatio);
        ctx.save();
        ctx.strokeStyle = playback.playing ? 'rgba(248, 113, 113, 0.96)' : 'rgba(251, 191, 36, 0.92)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX, cssHeight);
        ctx.stroke();
        ctx.fillStyle = playback.playing ? 'rgba(248, 113, 113, 0.96)' : 'rgba(251, 191, 36, 0.92)';
        ctx.beginPath();
        ctx.moveTo(playheadX, 0);
        ctx.lineTo(playheadX - 6, 10);
        ctx.lineTo(playheadX + 6, 10);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      syncMusicTrimInputsFromState();
      return;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width || 0, canvas.height || 0);
    }
    if (empty) {
      empty.hidden = false;
      empty.textContent = cached?.status === 'error' ? '波形の読込に失敗しました' : '波形を読み込み中...';
    }
  }

  async function ensureMusicWaveformPreview() {
    if (String(getCurrentStep()?.id || '') !== 'music') return;
    const canvas = els.detailBody?.querySelector('#musicTrimWaveformCanvas');
    const audio = state.musicStep.generatedAudio;
    const cacheKey = getMusicWaveformCacheKey();
    if (!(canvas instanceof HTMLCanvasElement) || !cacheKey || !audio?.previewUrl) return;
    const token = ++musicWaveformRenderToken;
    renderMusicWaveformPreview();
    try {
      await loadMusicWaveformData(cacheKey);
      if (token !== musicWaveformRenderToken) return;
      renderMusicWaveformPreview();
    } catch (_error) {
      if (token !== musicWaveformRenderToken) return;
      renderMusicWaveformPreview();
    }
  }

  function bindMusicAudioWaveformEvents() {
    stopMusicWaveformPlaybackLoop();
    const audio = els.detailBody?.querySelector('#musicAudioPlayer');
    if (!(audio instanceof HTMLAudioElement)) return;
    const refresh = () => {
      if (state.musicStep.generatedAudio && !(Number(state.musicStep.generatedAudio.durationSec) > 0) && Number(audio.duration) > 0) {
        state.musicStep.generatedAudio.durationSec = Number(audio.duration.toFixed(2));
      }
      renderMusicWaveformPreview();
    };
    audio.addEventListener('loadedmetadata', refresh);
    audio.addEventListener('timeupdate', refresh);
    audio.addEventListener('seeking', refresh);
    audio.addEventListener('seeked', refresh);
    audio.addEventListener('pause', refresh);
    audio.addEventListener('ended', refresh);
    audio.addEventListener('play', () => {
      renderMusicWaveformPreview();
      startMusicWaveformPlaybackLoop();
    });
  }

  function isImportedMusicAudio() {
    return String(state.musicStep.generatedAudio?.source || '').trim().toLowerCase() === 'imported';
  }

  function hasScenePlanSourceContext() {
    return !!(
      String(state.storyStep.scenarioText || '').trim()
      || String(state.storyStep.worldNotes || '').trim()
      || String(state.musicStep.lyricsText || '').trim()
      || String(state.musicStep.arrangementNotes || '').trim()
    );
  }

  function setMusicNotice(message, tone = 'info') {
    state.musicStep.notice = message ? { message: String(message), tone: String(tone || 'info') } : null;
  }

  function getMusicStoryContext() {
    const storyState = getStoryStepState();
    const parts = [];
    if (storyState.scenarioText) {
      parts.push(`scenario:\n${storyState.scenarioText}`);
    }
    if (storyState.worldNotes) {
      parts.push(`world_notes:\n${storyState.worldNotes}`);
    }
    if (storyState.idea) {
      parts.push(`story_idea:\n${storyState.idea}`);
    }
    return parts.filter(Boolean).join('\n\n').trim();
  }

  function applyStoryContextToMusicPrompt() {
    const storyContext = getMusicStoryContext();
    if (!storyContext) {
      setMusicNotice('先にシナリオ・世界観作成エリアで内容を準備してください', 'warning');
      renderDetail();
      return;
    }
    const current = String(state.musicStep.musicPrompt || '').trim();
    const merged = current ? `${current}\n\n${storyContext}` : storyContext;
    state.musicStep.musicPrompt = merged;
    state.musicStep.useStoryContext = true;
    state.canvas.updatedAt = Date.now();
    setMusicNotice('シナリオ・世界観の内容を音楽メモへ反映しました', 'success');
    renderDetail();
    scheduleSave();
  }

  async function generateMusicPlan() {
    const musicState = getMusicStepState();
    const storyState = getStoryStepState();
    const storyContext = musicState.useStoryContext ? getMusicStoryContext() : '';
    const characterContext = musicState.useCharacterContext ? getStoryCharacterContext() : '';
    const prompt = String(musicState.musicPrompt || '').trim();

    if (!prompt && !storyContext && !storyState.scenarioText) {
      setMusicNotice('先にシナリオ内容または曲の方向性メモを用意してください', 'warning');
      renderDetail();
      return;
    }

    if (musicPlanGenerationBusy) return;

    musicPlanGenerationBusy = true;
    setMusicNotice('歌詞・楽曲プランを生成中です...', 'info');
    renderDetail();

    try {
      const response = await fetch('/api/v1/production/music/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_text: storyState.scenarioText || storyContext,
          world_notes: storyState.worldNotes || '',
          character_context: characterContext,
          music_prompt: prompt,
          genre: storyState.genre || '',
          target_duration_sec: getEffectiveMusicDurationSec(),
          vocal_language: String(musicState.vocalLanguage || 'ja'),
          bpm: Number(musicState.bpm) || null,
          key_signature: String(musicState.keySignature || ''),
          has_vocals: !!musicState.hasVocals,
          instrumental_focus: !!musicState.instrumentalFocus,
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      state.musicStep.title = String(result?.title || state.musicStep.title || '').trim();
      state.musicStep.lyricsText = String(result?.lyrics_text || state.musicStep.lyricsText || '').trim();
      state.musicStep.tagsText = String(result?.music_tags || state.musicStep.tagsText || '').trim();
      state.musicStep.arrangementNotes = String(result?.arrangement_notes || state.musicStep.arrangementNotes || '').trim();
      if (result?.recommended_bpm) {
        state.musicStep.bpm = Math.max(60, Math.min(220, Number(result.recommended_bpm) || state.musicStep.bpm || 118));
      }
      if (result?.key_signature) {
        state.musicStep.keySignature = String(result.key_signature || '').trim();
      }
      if (!isImportedMusicAudio()) {
        state.musicStep.generatedAudio = null;
      }
      invalidateFinalMvOutputs({ keepClip: true });
      state.musicStep.lastGeneratedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setMusicNotice('歌詞・楽曲プランを生成しました', 'success');
      scheduleSave();
    } finally {
      musicPlanGenerationBusy = false;
      renderDetail();
    }
  }

  async function translateMusicField(fieldName, emptyMessage) {
    const input = els.detailBody.querySelector(`[data-music-field="${fieldName}"]`);
    const button = els.detailBody.querySelector(`[data-music-translate="${fieldName}"]`);
    const { translated, targetLangLabel } = await translateProductionText({
      text: input?.value || '',
      button,
      emptyMessage,
    });

    if (fieldName === 'musicPrompt') {
      state.musicStep.musicPrompt = translated;
    } else if (fieldName === 'lyricsText') {
      state.musicStep.lyricsText = translated;
      if (!isImportedMusicAudio()) {
        state.musicStep.generatedAudio = null;
      }
      invalidateFinalMvOutputs({ keepClip: true });
    } else if (fieldName === 'tagsText') {
      state.musicStep.tagsText = translated;
      if (!isImportedMusicAudio()) {
        state.musicStep.generatedAudio = null;
      }
      invalidateFinalMvOutputs({ keepClip: true });
    } else if (fieldName === 'arrangementNotes') {
      state.musicStep.arrangementNotes = translated;
      invalidateFinalMvOutputs({ keepClip: true });
    }
    state.canvas.updatedAt = Date.now();
    setMusicNotice(`${targetLangLabel}に翻訳しました`, 'success');
    renderDetail();
    scheduleSave();
  }

  function clearMusicPlan() {
    state.musicStep.title = '';
    state.musicStep.lyricsText = '';
    state.musicStep.tagsText = '';
    state.musicStep.arrangementNotes = '';
    state.musicStep.lastGeneratedAt = null;
    if (!isImportedMusicAudio()) {
      state.musicStep.generatedAudio = null;
    }
    invalidateFinalMvOutputs({ keepClip: true });
    state.canvas.updatedAt = Date.now();
    setMusicNotice('音楽プランをクリアしました', 'info');
    renderDetail();
    scheduleSave();
  }

  function clearMusicAudio({ message = '音声素材をクリアしました', rerender = true, save = true } = {}) {
    state.musicStep.generatedAudio = null;
    invalidateFinalMvOutputs({ keepClip: true });
    state.canvas.updatedAt = Date.now();
    setMusicNotice(message, 'info');
    if (rerender) renderDetail();
    if (save) scheduleSave();
  }

  async function trimMusicAudio() {
    const audio = state.musicStep.generatedAudio;
    if (!audio?.filename) {
      setMusicNotice('先に音声素材を用意してください', 'warning');
      renderDetail();
      return;
    }
    if (musicAudioTrimBusy) {
      return;
    }

    const trimRange = getMusicAudioTrimRange();
    if (trimRange.keepDurationSec <= 0.05) {
      setMusicNotice('残す区間が短すぎます。開始・終了位置を確認してください', 'warning');
      renderDetail();
      return;
    }

    musicAudioTrimBusy = true;
    setMusicNotice('音声をトリミング中です...', 'info');
    renderDetail();

    try {
      const response = await fetch('/api/v1/production/music/trim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          filename: String(audio.filename || ''),
          trim_start_sec: trimRange.startSec,
          trim_end_sec: trimRange.endSec,
          source: String(audio.source || 'generated'),
          original_filename: String(audio.originalName || audio.filename || ''),
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      const durationSec = Math.max(0.1, Number(result?.duration_sec || trimRange.keepDurationSec) || trimRange.keepDurationSec);
      state.storyStep.targetDurationSec = Math.max(10, Math.min(600, Math.round(durationSec) || getEffectiveMusicDurationSec()));
      state.musicStep.durationOverrideSec = null;
      state.musicStep.generatedAudio = {
        filename: String(result?.filename || ''),
        originalName: String(result?.original_filename || result?.filename || ''),
        subfolder: String(result?.subfolder || ''),
        type: String(result?.type || 'output'),
        mediaType: String(result?.media_type || 'audio'),
        previewUrl: String(result?.preview_url || ''),
        backend: String(result?.backend || 'ffmpeg-trim'),
        source: String(result?.source || audio.source || 'generated'),
        durationSec,
        elapsedTime: Number(result?.elapsed_time || 0),
        trimStartSec: 0,
        trimEndSec: durationSec,
      };
      invalidateFinalMvOutputs({ keepClip: true });
      state.musicStep.lastGeneratedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setMusicNotice(`音声を ${trimRange.startSec.toFixed(1)}〜${trimRange.endSec.toFixed(1)} 秒でトリミングしました`, 'success');
      renderDetail();
      scheduleSave();
    } finally {
      musicAudioTrimBusy = false;
      renderDetail();
    }
  }

  async function importMusicAudio(file) {
    if (!(file instanceof File)) return;
    if (!String(file.type || '').startsWith('audio/')) {
      throw new Error('音声ファイルを選択してください');
    }
    const musicState = getMusicStepState();

    const formData = new FormData();
    formData.append('client_session_id', getSessionId());
    formData.append('file', file);

    setMusicNotice('外部音楽を取り込み中です...', 'info');
    renderDetail();

    const response = await fetch('/api/v1/production/music/import', {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`HTTP ${response.status}: ${payload}`);
    }
    const result = await response.json();
    const durationSec = Math.max(10, Math.min(600, Math.round(Number(result?.duration_sec) || getEffectiveMusicDurationSec())));
    state.storyStep.targetDurationSec = durationSec;
    state.musicStep.durationOverrideSec = null;
    state.musicStep.generatedAudio = {
      filename: String(result?.filename || ''),
      originalName: String(result?.original_filename || result?.filename || ''),
      subfolder: String(result?.subfolder || ''),
      type: String(result?.type || 'output'),
      mediaType: String(result?.media_type || 'audio'),
      previewUrl: String(result?.preview_url || ''),
      backend: String(result?.backend || 'external-audio'),
      source: String(result?.source || 'imported'),
      durationSec: Number(result?.duration_sec || 0),
      elapsedTime: Number(result?.elapsed_time || 0),
      trimStartSec: 0,
      trimEndSec: Number(result?.duration_sec || 0),
    };
    invalidateFinalMvOutputs({ keepClip: true });
    state.musicStep.lastGeneratedAt = Date.now();
    state.canvas.updatedAt = Date.now();
    const shouldAutoSuggest = !!musicState.autoSuggestScenePlanOnImport && hasScenePlanSourceContext();
    setMusicNotice(
      shouldAutoSuggest
        ? `外部音楽を読み込み、制作尺を ${durationSec} 秒に合わせました。シーン尺を再提案します...`
        : `外部音楽を読み込み、制作尺を ${durationSec} 秒に合わせました`,
      'success',
    );
    renderDetail();
    scheduleSave();
    if (shouldAutoSuggest) {
      await proposeScenePlanFromMusicStep();
    }
  }

  async function produceMusicAudio() {
    const musicState = getMusicStepState();
    const tags = String(musicState.tagsText || '').trim();
    const lyrics = String(musicState.lyricsText || '').trim();
    const language = String(musicState.vocalLanguage || 'ja');

    if (!tags) {
      setMusicNotice('先に音楽タグ / 楽曲プロンプトを用意してください', 'warning');
      renderDetail();
      return;
    }
    if (language !== 'inst' && musicState.hasVocals && !lyrics) {
      setMusicNotice('歌詞を含む設定のため、先に確定歌詞を用意してください', 'warning');
      renderDetail();
      return;
    }
    if (musicAudioGenerationBusy) {
      return;
    }

    musicAudioGenerationBusy = true;
    setMusicNotice('音楽を生成中です...', 'info');
    renderDetail();

    try {
      const response = await fetch('/api/v1/production/music/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          tags,
          lyrics,
          language,
          duration: getEffectiveMusicDurationSec(),
          bpm: Number(musicState.bpm) || null,
          timesignature: '4',
          keyscale: String(musicState.keySignature || ''),
          steps: 8,
          cfg: 3.0,
          thinking: false,
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      state.musicStep.generatedAudio = {
        filename: String(result?.filename || ''),
        originalName: String(result?.original_filename || result?.filename || ''),
        subfolder: String(result?.subfolder || ''),
        type: String(result?.type || 'output'),
        mediaType: String(result?.media_type || 'audio'),
        previewUrl: String(result?.preview_url || ''),
        backend: String(result?.backend || ''),
        source: String(result?.source || 'generated'),
        durationSec: Number(result?.duration_sec || 0),
        elapsedTime: Number(result?.elapsed_time || 0),
        trimStartSec: 0,
        trimEndSec: Number(result?.duration_sec || 0),
      };
      invalidateFinalMvOutputs({ keepClip: true });
      state.musicStep.lastGeneratedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setMusicNotice('音楽を生成しました', 'success');
      renderDetail();
      scheduleSave();
    } finally {
      musicAudioGenerationBusy = false;
      renderDetail();
    }
  }

  function getSceneImageStepState() {
    return state.sceneImageStep;
  }

  function setSceneImageNotice(message, tone = 'info') {
    state.sceneImageStep.notice = message ? { message: String(message), tone: String(tone || 'info') } : null;
  }

  function isAbortLikeError(error) {
    const name = String(error?.name || '').trim();
    const message = String(error?.message || '').trim().toLowerCase();
    return name === 'AbortError' || message.includes('aborted') || message.includes('abort');
  }

  async function requestProductionCancel(target) {
    try {
      await fetch('/api/v1/production/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          target: String(target || '').trim(),
        }),
      });
    } catch (_error) {
      // noop
    }
  }

  async function requestSceneImageGeneration(payload) {
    const controller = new AbortController();
    sceneImageGenerationAbortController = controller;
    try {
      const response = await fetch('/api/v1/production/scene-image/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payloadText = await response.text();
        throw new Error(`HTTP ${response.status}: ${payloadText}`);
      }
      return await response.json();
    } finally {
      if (sceneImageGenerationAbortController === controller) {
        sceneImageGenerationAbortController = null;
      }
    }
  }

  function cancelSceneImageGeneration() {
    if (!sceneImageGenerationBusy) return;
    sceneImageBatchCancelRequested = true;
    requestProductionCancel('scene-image');
    sceneImageGenerationAbortController?.abort();
    setSceneImageNotice('シーン画像生成を中止しています...', 'info');
    renderDetail();
  }

  function getSceneImageTargetSceneCount() {
    return Math.max(1, Math.min(MAX_SCENE_COUNT, Number(state.storyStep.sceneCount) || state.sceneImageStep.scenePrompts.length || 5));
  }

  function getSceneImageEffectiveDurationSec() {
    return Math.max(10, Number(getEffectiveMusicDurationSec()) || Number(state.storyStep.targetDurationSec) || 30);
  }

  function getSceneImageDisplayPrompts() {
    const sceneState = getSceneImageStepState();
    const count = getSceneImageTargetSceneCount();
    const existing = Array.isArray(sceneState.scenePrompts) ? sceneState.scenePrompts.slice(0, count) : [];
    while (existing.length < count) {
      existing.push({
        sceneIndex: existing.length + 1,
        prompt: '',
        durationSec: 0,
        lyricExcerpt: '',
        transitionType: normalizeSceneTransitionType('none', { sceneIndex: existing.length + 1 }),
        transitionReason: existing.length === 0 ? '先頭シーンのため遷移なし' : '',
        image: null,
      });
    }
    existing.forEach((item, index) => {
      item.transitionType = normalizeSceneTransitionType(item?.transitionType, { sceneIndex: index + 1 });
      item.transitionReason = normalizeSceneTransitionReason(item?.transitionReason);
    });
    return existing;
  }

  function getSelectedScenePromptItem() {
    const sceneState = getSceneImageStepState();
    const prompts = getSceneImageDisplayPrompts();
    const index = Math.max(0, Math.min(Number(sceneState.selectedSceneIndex || 0) || 0, prompts.length - 1));
    sceneState.selectedSceneIndex = index;
    return prompts[index] || null;
  }

  function getSceneImageReferenceFilenames() {
    const characterState = getCharacterStepState();
    const ordered = [
      characterState.characterImage?.filename,
      characterState.characterSheetImage?.filename,
      characterState.dropSlots?.[0]?.filename,
      characterState.dropSlots?.[1]?.filename,
      characterState.dropSlots?.[2]?.filename,
    ].map((value) => String(value || '').trim()).filter(Boolean);
    return Array.from(new Set(ordered)).slice(0, 3);
  }

  function updateStorySceneCount(sceneCount, { rerender = true, save = true } = {}) {
    const normalizedCount = Math.max(1, Math.min(MAX_SCENE_COUNT, Number(sceneCount) || 5));
    state.storyStep.sceneCount = normalizedCount;
    state.sceneImageStep.scenePrompts = (Array.isArray(state.sceneImageStep.scenePrompts) ? state.sceneImageStep.scenePrompts : []).slice(0, normalizedCount);
    state.sceneVideoStep.sceneVideos = (Array.isArray(state.sceneVideoStep.sceneVideos) ? state.sceneVideoStep.sceneVideos : []).slice(0, normalizedCount).map((item) => ({
      ...item,
      video: null,
    }));
    state.sceneImageStep.selectedSceneIndex = Math.max(0, Math.min(Number(state.sceneImageStep.selectedSceneIndex || 0) || 0, normalizedCount - 1));
    state.sceneVideoStep.selectedSceneIndex = Math.max(0, Math.min(Number(state.sceneVideoStep.selectedSceneIndex || 0) || 0, normalizedCount - 1));
    state.sceneVideoStep.lastGeneratedAt = null;
    invalidateFinalMvOutputs();
    state.canvas.updatedAt = Date.now();
    if (rerender) renderDetail();
    if (save) scheduleSave();
  }

  function updateScenePromptDuration(index, durationSec, { rerender = true, save = true } = {}) {
    const prompts = getSceneImageDisplayPrompts();
    const safeIndex = Math.max(0, Math.min(Number(index) || 0, prompts.length - 1));
    if (!prompts[safeIndex]) return;
    const normalizedDuration = Math.max(1, Math.min(15, Number(durationSec) || prompts[safeIndex].durationSec || 5));
    prompts[safeIndex].durationSec = normalizedDuration;
    state.sceneImageStep.scenePrompts = prompts;

    const items = getSceneVideoDisplayItems();
    if (items[safeIndex]) {
      items[safeIndex].durationSec = normalizedDuration;
      items[safeIndex].video = null;
      syncSceneVideoItems(items);
    }
    invalidateFinalMvOutputs();
    state.canvas.updatedAt = Date.now();
    if (rerender) renderDetail();
    if (save) scheduleSave();
  }

  function updateSceneTransitionType(index, transitionType, { rerender = true, save = true } = {}) {
    const prompts = getSceneImageDisplayPrompts();
    const safeIndex = Math.max(0, Math.min(Number(index) || 0, prompts.length - 1));
    if (!prompts[safeIndex]) return;
    const normalized = normalizeSceneTransitionType(transitionType, { sceneIndex: safeIndex + 1 });
    prompts[safeIndex].transitionType = normalized;
    prompts[safeIndex].transitionReason = safeIndex === 0 ? '先頭シーンのため遷移なし' : '手動で遷移を調整済み';
    state.sceneImageStep.scenePrompts = prompts;

    const items = getSceneVideoDisplayItems();
    if (items[safeIndex]) {
      items[safeIndex].transitionType = normalized;
      items[safeIndex].transitionReason = prompts[safeIndex].transitionReason;
    }
    if (safeIndex > 0 && items[safeIndex - 1]) {
      items[safeIndex - 1].video = null;
    }
    syncSceneVideoItems(items);
    invalidateFinalMvOutputs();
    state.canvas.updatedAt = Date.now();
    if (rerender) renderDetail();
    if (save) scheduleSave();
  }

  async function proposeScenePlan() {
    const storyState = getStoryStepState();
    const musicState = getMusicStepState();
    const sceneCount = getSceneImageTargetSceneCount();
    const scenarioText = String(storyState.scenarioText || '').trim();
    const lyricsText = String(musicState.lyricsText || '').trim();
    const worldNotes = String(storyState.worldNotes || '').trim();
    const arrangementNotes = String(musicState.arrangementNotes || '').trim();
    if (!scenarioText && !lyricsText && !worldNotes) {
      setSceneImageNotice('先にシナリオまたは歌詞を用意してください', 'warning');
      renderDetail();
      return;
    }
    if (scenePlanGenerationBusy) return;

    scenePlanGenerationBusy = true;
    setSceneImageNotice('シーン尺と遷移を自動提案中です...', 'info');
    renderDetail();

    try {
      const workflowMode = getSelectedSceneVideoWorkflowMode();
      const maxDurationSec = getSceneDurationProposalMaxSec(workflowMode);
      const response = await fetch('/api/v1/production/scene-plan/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_text: scenarioText,
          lyrics_text: lyricsText,
          world_notes: worldNotes,
          arrangement_notes: arrangementNotes,
          scene_count: sceneCount,
          target_duration_sec: getSceneImageEffectiveDurationSec(),
          pipeline_preset_id: String(state.selectedPipelinePresetId || ''),
          workflow_mode: workflowMode,
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      const suggestedSceneCount = Math.max(1, Math.min(MAX_SCENE_COUNT, Number(result?.scene_count) || sceneCount));
      const durations = Array.isArray(result?.scene_durations_sec) ? result.scene_durations_sec : [];
      const transitions = Array.isArray(result?.scene_transitions) ? result.scene_transitions : [];
      const transitionReasons = Array.isArray(result?.scene_transition_reasons) ? result.scene_transition_reasons : [];
      if (suggestedSceneCount !== sceneCount) {
        updateStorySceneCount(suggestedSceneCount, { rerender: false, save: false });
      }
      const prompts = getSceneImageDisplayPrompts();
      for (let index = 0; index < prompts.length; index += 1) {
        if (durations[index] != null) {
          prompts[index].durationSec = Math.max(1, Math.min(maxDurationSec, Number(durations[index]) || prompts[index].durationSec || 5));
        }
        prompts[index].transitionType = normalizeSceneTransitionType(transitions[index] || prompts[index].transitionType || 'none', { sceneIndex: index + 1 });
        prompts[index].transitionReason = normalizeSceneTransitionReason(transitionReasons[index] || prompts[index].transitionReason || (index === 0 ? '先頭シーンのため遷移なし' : ''));
      }
      state.sceneImageStep.scenePrompts = prompts;

      const items = getSceneVideoDisplayItems();
      for (let index = 0; index < items.length; index += 1) {
        items[index].durationSec = Math.max(1, Math.min(maxDurationSec, Number(prompts[index]?.durationSec || items[index].durationSec || 5) || 5));
        items[index].transitionType = normalizeSceneTransitionType(prompts[index]?.transitionType || items[index].transitionType || 'none', { sceneIndex: index + 1 });
        items[index].transitionReason = normalizeSceneTransitionReason(prompts[index]?.transitionReason || items[index].transitionReason || '');
        items[index].video = null;
      }
      syncSceneVideoItems(items);
      invalidateFinalMvOutputs();
      state.canvas.updatedAt = Date.now();
      setSceneImageNotice(suggestedSceneCount !== sceneCount ? `シーン数を ${suggestedSceneCount} に調整し、尺と遷移の提案を反映しました` : 'シーン尺と遷移の提案を反映しました', 'success');
      renderDetail();
      scheduleSave();
    } finally {
      scenePlanGenerationBusy = false;
      renderDetail();
    }
  }

  async function proposeScenePlanFromMusicStep() {
    if (!hasScenePlanSourceContext()) {
      setMusicNotice('先にシナリオ・歌詞・アレンジメモのいずれかを用意してください', 'warning');
      renderDetail();
      return;
    }
    if (String(state.selectedStepId || '') !== 'scene_image') {
      selectStep('scene_image');
    }
    await proposeScenePlan();
  }

  async function generateScenePrompts() {
    const sceneState = getSceneImageStepState();
    const storyState = getStoryStepState();
    const musicState = getMusicStepState();
    const sceneCount = getSceneImageTargetSceneCount();
    const scenarioText = sceneState.useStoryContext ? String(storyState.scenarioText || '').trim() : '';
    const worldNotes = sceneState.useStoryContext ? String(storyState.worldNotes || '').trim() : '';
    const lyricsText = sceneState.useMusicContext ? String(musicState.lyricsText || '').trim() : '';
    const arrangementNotes = sceneState.useMusicContext ? String(musicState.arrangementNotes || '').trim() : '';
    const musicTags = sceneState.useMusicContext ? String(musicState.tagsText || '').trim() : '';
    const characterContext = sceneState.useCharacterContext ? getStoryCharacterContext() : '';

    if (!scenarioText && !lyricsText && !characterContext) {
      setSceneImageNotice('先にシナリオ・音楽・キャラクタ情報のいずれかを用意してください', 'warning');
      renderDetail();
      return;
    }
    if (scenePromptGenerationBusy) return;

    scenePromptGenerationBusy = true;
    setSceneImageNotice('シーンプロンプトを生成中です...', 'info');
    renderDetail();

    try {
      const workflowMode = getSelectedSceneVideoWorkflowMode();
      const response = await fetch('/api/v1/production/scene-image/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_text: scenarioText,
          world_notes: worldNotes,
          lyrics_text: lyricsText,
          arrangement_notes: arrangementNotes,
          music_tags: musicTags,
          character_context: characterContext,
          scene_count: sceneCount,
          target_duration_sec: getSceneImageEffectiveDurationSec(),
          pipeline_preset_id: String(state.selectedPipelinePresetId || ''),
          workflow_mode: workflowMode,
          language: 'en',
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      const prompts = Array.isArray(result?.scene_prompts) ? result.scene_prompts : [];
      state.sceneImageStep.scenePrompts = prompts.slice(0, sceneCount).map((item, index) => ({
        sceneIndex: Math.max(1, Number(item?.scene_index || item?.sceneIndex || index + 1) || index + 1),
        prompt: String(item?.prompt || '').trim(),
        durationSec: Math.max(1, Number(item?.duration_sec || item?.durationSec || 0) || 0),
        lyricExcerpt: String(item?.lyric_excerpt || item?.lyricExcerpt || '').trim(),
        transitionType: normalizeSceneTransitionType(item?.transition_type || item?.transitionType || state.sceneImageStep.scenePrompts[index]?.transitionType || 'none', { sceneIndex: index + 1 }),
        transitionReason: normalizeSceneTransitionReason(item?.transition_reason || item?.transitionReason || state.sceneImageStep.scenePrompts[index]?.transitionReason || (index === 0 ? '先頭シーンのため遷移なし' : '')),
        image: state.sceneImageStep.scenePrompts[index]?.image || null,
      }));
      invalidateAllSceneVideos();
      state.sceneImageStep.selectedSceneIndex = 0;
      state.sceneImageStep.lastPromptGeneratedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setSceneImageNotice('シーンプロンプトを生成しました', 'success');
      renderDetail();
      scheduleSave();
    } finally {
      scenePromptGenerationBusy = false;
      renderDetail();
    }
  }

  async function translateSelectedScenePrompt() {
    const item = getSelectedScenePromptItem();
    const button = els.detailBody.querySelector('#scenePromptTranslateBtn');
    const { translated, targetLangLabel } = await translateProductionText({
      text: item?.prompt || '',
      button,
      emptyMessage: '翻訳するシーンプロンプトがありません',
    });
    const prompts = getSceneImageDisplayPrompts();
    const index = Math.max(0, Number(state.sceneImageStep.selectedSceneIndex || 0) || 0);
    prompts[index].prompt = translated;
    prompts[index].image = null;
    state.sceneImageStep.scenePrompts = prompts;
    invalidateSceneVideoAtIndex(index);
    state.canvas.updatedAt = Date.now();
    setSceneImageNotice(`${targetLangLabel}に翻訳しました`, 'success');
    renderDetail();
    scheduleSave();
  }

  async function translateSelectedSceneVideoPrompt() {
    const item = getSelectedSceneVideoItem();
    const button = els.detailBody.querySelector('#sceneVideoPromptTranslateBtn');
    const { translated, targetLangLabel } = await translateProductionText({
      text: item?.prompt || '',
      button,
      emptyMessage: '翻訳する動画用プロンプトがありません',
    });
    const items = getSceneVideoDisplayItems();
    const index = Math.max(0, Number(state.sceneVideoStep.selectedSceneIndex || 0) || 0);
    if (items[index]) {
      items[index].prompt = translated;
      items[index].promptCustomized = true;
      items[index].video = null;
      syncSceneVideoItems(items);
    }
    state.canvas.updatedAt = Date.now();
    setSceneVideoNotice(`${targetLangLabel}に翻訳しました`, 'success');
    invalidateFinalMvOutputs();
    renderDetail();
    scheduleSave();
  }

  function clearScenePrompts() {
    state.sceneImageStep.scenePrompts = [];
    state.sceneImageStep.selectedSceneIndex = 0;
    state.sceneImageStep.lastPromptGeneratedAt = null;
    state.sceneVideoStep.sceneVideos = [];
    state.sceneVideoStep.selectedSceneIndex = 0;
    state.sceneVideoStep.lastGeneratedAt = null;
    invalidateFinalMvOutputs();
    state.canvas.updatedAt = Date.now();
    setSceneImageNotice('シーンプロンプトをクリアしました', 'info');
    renderDetail();
    scheduleSave();
  }

  function getSceneVideoStepState() {
    return state.sceneVideoStep;
  }

  function setSceneVideoNotice(message, tone = 'info') {
    state.sceneVideoStep.notice = message ? { message: String(message), tone: String(tone || 'info') } : null;
  }

  async function requestSceneVideoGeneration(payload) {
    const controller = new AbortController();
    sceneVideoGenerationAbortController = controller;
    try {
      const response = await fetch('/api/v1/production/scene-video/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payloadText = await response.text();
        throw new Error(`HTTP ${response.status}: ${payloadText}`);
      }
      return await response.json();
    } finally {
      if (sceneVideoGenerationAbortController === controller) {
        sceneVideoGenerationAbortController = null;
      }
    }
  }

  function cancelSceneVideoGeneration() {
    if (!sceneVideoGenerationBusy) return;
    sceneVideoBatchCancelRequested = true;
    requestProductionCancel('scene-video');
    sceneVideoGenerationAbortController?.abort();
    setSceneVideoNotice('シーン動画生成を中止しています...', 'info');
    renderDetail();
  }

  function getFinalMvStepState() {
    return state.finalMvStep;
  }

  function setFinalMvNotice(message, tone = 'info') {
    state.finalMvStep.notice = message ? { message: String(message), tone: String(tone || 'info') } : null;
  }

  function normalizeFinalMvMediaItem(item) {
    if (!item || typeof item !== 'object') return null;
    return {
      filename: String(item.filename || ''),
      subfolder: String(item.subfolder || ''),
      type: String(item.type || 'output'),
      mediaType: String(item.mediaType || item.media_type || 'video'),
      previewUrl: String(item.previewUrl || item.preview_url || ''),
    };
  }

  function invalidateFinalMvOutputs({ keepClip = false } = {}) {
    if (!keepClip) {
      state.finalMvStep.clipVideo = null;
    }
    state.finalMvStep.finalVideo = null;
    state.finalMvStep.lastRenderedAt = null;
  }

  function getFinalMvSceneVideoFilenames() {
    return getSceneVideoDisplayItems()
      .map((item) => String(item?.video?.filename || '').trim())
      .filter(Boolean);
  }

  function getDefaultSceneVideoWorkflowMode() {
    const pipelineId = String(state.selectedPipelinePresetId || '').trim().toLowerCase();
    if (!pipelineId) return 'ltx';
    if (pipelineId.includes('flf')) return 'ltx_flf';
    return 'ltx';
  }

  function getSelectedSceneVideoWorkflowMode() {
    return String(state.sceneVideoStep.workflowMode || getDefaultSceneVideoWorkflowMode() || 'ltx').trim().toLowerCase();
  }

  function getDefaultSceneVideoFps(workflowMode) {
    const normalized = String(workflowMode || getDefaultSceneVideoWorkflowMode() || 'auto').trim().toLowerCase();
    return normalized === 'ltx' || normalized === 'ltx_flf' ? 25 : 16;
  }

  function isLtxSceneVideoWorkflowMode(workflowMode) {
    const normalized = String(workflowMode || getDefaultSceneVideoWorkflowMode() || 'auto').trim().toLowerCase();
    return normalized === 'ltx' || normalized === 'ltx_flf';
  }

  function getSceneDurationProposalMaxSec(workflowMode) {
    return isLtxSceneVideoWorkflowMode(workflowMode) ? LTX_SCENE_DURATION_MAX_SEC : DEFAULT_SCENE_DURATION_MAX_SEC;
  }

  function getSceneVideoWorkflowLabel(mode, { isDefault = false } = {}) {
    const normalized = String(mode || 'auto').trim().toLowerCase();
    if (normalized === 'flf') return isDefault ? 'FLF寄り' : 'FLF 優先';
    if (normalized === 'i2v') return isDefault ? 'I2V寄り' : 'I2V 優先';
    if (normalized === 'ltx') return isDefault ? 'LTX I2V寄り' : 'LTX I2V';
    if (normalized === 'ltx_flf') return isDefault ? 'LTX FLF寄り' : 'LTX FLF';
    return '自動判定';
  }

  function buildDefaultSceneVideoPrompt(sceneItem) {
    const item = sceneItem || {};
    const parts = [];
    if (state.sceneVideoStep.useScenePrompt && String(item.prompt || '').trim()) {
      parts.push(String(item.prompt || '').trim());
    }
    if (state.sceneVideoStep.useMusicContext && String(item.lyricExcerpt || '').trim()) {
      parts.push(`lyric timing cue: ${String(item.lyricExcerpt || '').trim()}`);
    }
    if (state.sceneVideoStep.useMusicContext && String(state.musicStep.arrangementNotes || '').trim()) {
      parts.push(String(state.musicStep.arrangementNotes || '').trim().split('\n').slice(0, 2).join(', '));
    }
    parts.push('subtle cinematic motion, gentle camera movement, natural parallax, coherent anime music video shot');
    parts.push('avoid freeze frame, avoid duplicate subject, maintain character consistency');
    return parts.filter(Boolean).join(', ');
  }

  function getSceneVideoDisplayItems() {
    const videoState = getSceneVideoStepState();
    const baseScenes = getSceneImageDisplayPrompts();
    const count = baseScenes.length;
    const existing = Array.isArray(videoState.sceneVideos) ? videoState.sceneVideos.slice(0, count) : [];
    while (existing.length < count) {
      existing.push(null);
    }
    return baseScenes.map((sceneItem, index) => {
      const current = existing[index] && typeof existing[index] === 'object' ? existing[index] : {};
      const defaultPrompt = buildDefaultSceneVideoPrompt(sceneItem);
      const hasCustomPrompt = !!current.promptCustomized;
      return {
        sceneIndex: Math.max(1, Number(sceneItem?.sceneIndex || index + 1) || index + 1),
        prompt: hasCustomPrompt ? String(current.prompt || '').trim() : defaultPrompt,
        promptCustomized: hasCustomPrompt,
        durationSec: Math.max(1, Number(current.durationSec || sceneItem?.durationSec || 5) || 5),
        image: sceneItem?.image || current.image || null,
        lyricExcerpt: String(sceneItem?.lyricExcerpt || current.lyricExcerpt || ''),
        transitionType: normalizeSceneTransitionType(current.transitionType || sceneItem?.transitionType || 'none', { sceneIndex: index + 1 }),
        transitionReason: normalizeSceneTransitionReason(current.transitionReason || sceneItem?.transitionReason || (index === 0 ? '先頭シーンのため遷移なし' : '')),
        video: current.video && typeof current.video === 'object' ? { ...current.video } : null,
      };
    });
  }

  function getSelectedSceneVideoItem() {
    const videoState = getSceneVideoStepState();
    const items = getSceneVideoDisplayItems();
    const index = Math.max(0, Math.min(Number(videoState.selectedSceneIndex || 0) || 0, items.length - 1));
    videoState.selectedSceneIndex = index;
    return items[index] || null;
  }

  function syncSceneVideoItems(items) {
    state.sceneVideoStep.sceneVideos = Array.isArray(items)
      ? items.slice(0, MAX_SCENE_COUNT).map((item, index) => ({
        ...item,
        transitionType: normalizeSceneTransitionType(item?.transitionType || 'none', { sceneIndex: index + 1 }),
        transitionReason: normalizeSceneTransitionReason(item?.transitionReason || (index === 0 ? '先頭シーンのため遷移なし' : '')),
      }))
      : [];
  }

  function invalidateSceneVideoAtIndex(index, { resetPrompt = true } = {}) {
    const items = getSceneVideoDisplayItems();
    const safeIndex = Math.max(0, Math.min(Number(index) || 0, items.length - 1));
    if (!items[safeIndex]) return;
    if (resetPrompt) {
      items[safeIndex].prompt = '';
      items[safeIndex].promptCustomized = false;
    }
    items[safeIndex].video = null;
    syncSceneVideoItems(items);
    invalidateFinalMvOutputs();
  }

  function invalidateAllSceneVideos() {
    const items = getSceneVideoDisplayItems().map((item) => ({ ...item, video: null }));
    syncSceneVideoItems(items);
    state.sceneVideoStep.lastGeneratedAt = null;
    invalidateFinalMvOutputs();
  }

  function getSceneVideoBoundaryTransition(index) {
    const scenes = getSceneImageDisplayPrompts();
    const nextItem = scenes[index + 1];
    return normalizeSceneTransitionType(nextItem?.transitionType || 'none', { sceneIndex: index + 2 });
  }

  function getEffectiveSceneVideoWorkflowMode(index) {
    const baseMode = String(state.sceneVideoStep.workflowMode || getDefaultSceneVideoWorkflowMode() || 'auto').trim().toLowerCase();
    const boundaryTransition = getSceneVideoBoundaryTransition(index);
    if (boundaryTransition === 'flf') {
      if (baseMode === 'ltx') return 'ltx_flf';
      if (baseMode === 'auto') return 'flf';
    }
    return baseMode;
  }

  function getSceneVideoEndImageFilename(index) {
    const scenes = getSceneImageDisplayPrompts();
    const currentMode = String(getEffectiveSceneVideoWorkflowMode(index) || getDefaultSceneVideoWorkflowMode() || 'auto');
    if (currentMode === 'i2v' || currentMode === 'ltx') return '';
    if (getSceneVideoBoundaryTransition(index) !== 'flf' && currentMode !== 'flf' && currentMode !== 'ltx_flf') return '';
    const nextItem = scenes[index + 1];
    return String(nextItem?.image?.filename || '').trim();
  }

  function getFinalMvXfadeTransitions() {
    const prompts = getSceneImageDisplayPrompts();
    if (prompts.length < 2) return [];
    return prompts.slice(1).map((item, index) => {
      const type = normalizeSceneTransitionType(item?.transitionType || 'none', { sceneIndex: index + 2 });
      if (type === 'crossfade') return 'dissolve';
      if (type === 'fade_black') return 'fadeblack';
      return '';
    });
  }

  async function generateSelectedSceneVideo() {
    const selected = getSelectedSceneVideoItem();
    const items = getSceneVideoDisplayItems();
    const index = Math.max(0, Number(state.sceneVideoStep.selectedSceneIndex || 0) || 0);
    const workflowMode = String(getEffectiveSceneVideoWorkflowMode(index) || getDefaultSceneVideoWorkflowMode() || 'auto');
    if (!selected?.image?.filename) {
      setSceneVideoNotice('先にこのシーンの画像を用意してください', 'warning');
      renderDetail();
      return;
    }
    if (!String(selected.prompt || '').trim()) {
      setSceneVideoNotice('先に動画用プロンプトを用意してください', 'warning');
      renderDetail();
      return;
    }
    if (sceneVideoGenerationBusy) return;

    sceneVideoGenerationBusy = true;
    sceneVideoBatchCancelRequested = false;
    setSceneVideoNotice(`シーン${selected.sceneIndex} の動画を生成中です...`, 'info');
    renderDetail();

    try {
      const result = await requestSceneVideoGeneration({
        client_session_id: getSessionId(),
        scene_index: selected.sceneIndex,
        prompt: String(selected.prompt || '').trim(),
        image_filename: String(selected.image.filename || '').trim(),
        end_image_filename: getSceneVideoEndImageFilename(index),
        duration_sec: Math.max(1, Number(selected.durationSec || 5) || 5),
        fps: Math.max(8, Math.min(32, Number(state.sceneVideoStep.fps) || 16)),
        workflow_mode: workflowMode,
        audio_off: isLtxSceneVideoWorkflowMode(workflowMode) ? !!state.sceneVideoStep.audioOff : false,
      });
      items[index].video = {
        filename: String(result?.filename || ''),
        previewUrl: String(result?.preview_url || ''),
        subfolder: String(result?.subfolder || ''),
        type: String(result?.type || 'output'),
        workflow: String(result?.workflow || ''),
        promptId: String(result?.prompt_id || ''),
        fps: Math.max(8, Math.min(32, Number(result?.fps) || Number(state.sceneVideoStep.fps) || 16)),
        durationSec: Math.max(1, Number(result?.duration_sec || selected.durationSec || 5) || 5),
      };
      syncSceneVideoItems(items);
      invalidateFinalMvOutputs();
      state.sceneVideoStep.lastGeneratedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setSceneVideoNotice(`シーン${selected.sceneIndex} の動画を生成しました`, 'success');
      renderDetail();
      scheduleSave();
    } catch (error) {
      if (isAbortLikeError(error)) {
        setSceneVideoNotice(`シーン${selected.sceneIndex} の動画生成を中止しました`, 'info');
        renderDetail();
        return;
      }
      throw error;
    } finally {
      sceneVideoGenerationBusy = false;
      sceneVideoBatchCancelRequested = false;
      renderDetail();
    }
  }

  async function generateSceneVideoAtIndex(index, { rerender = true, save = true } = {}) {
    const items = getSceneVideoDisplayItems();
    const safeIndex = Math.max(0, Math.min(Number(index) || 0, items.length - 1));
    const selected = items[safeIndex] || null;
    const workflowMode = String(getEffectiveSceneVideoWorkflowMode(safeIndex) || getDefaultSceneVideoWorkflowMode() || 'auto');
    if (!selected?.image?.filename || !String(selected.prompt || '').trim()) {
      return { skipped: true, sceneIndex: selected?.sceneIndex || safeIndex + 1 };
    }

    const result = await requestSceneVideoGeneration({
      client_session_id: getSessionId(),
      scene_index: selected.sceneIndex,
      prompt: String(selected.prompt || '').trim(),
      image_filename: String(selected.image.filename || '').trim(),
      end_image_filename: getSceneVideoEndImageFilename(safeIndex),
      duration_sec: Math.max(1, Number(selected.durationSec || 5) || 5),
      fps: Math.max(8, Math.min(32, Number(state.sceneVideoStep.fps) || 16)),
      workflow_mode: workflowMode,
      audio_off: isLtxSceneVideoWorkflowMode(workflowMode) ? !!state.sceneVideoStep.audioOff : false,
    });
    items[safeIndex].video = {
      filename: String(result?.filename || ''),
      previewUrl: String(result?.preview_url || ''),
      subfolder: String(result?.subfolder || ''),
      type: String(result?.type || 'output'),
      workflow: String(result?.workflow || ''),
      promptId: String(result?.prompt_id || ''),
      fps: Math.max(8, Math.min(32, Number(result?.fps) || Number(state.sceneVideoStep.fps) || 16)),
      durationSec: Math.max(1, Number(result?.duration_sec || selected.durationSec || 5) || 5),
    };
    syncSceneVideoItems(items);
    invalidateFinalMvOutputs();
    state.sceneVideoStep.selectedSceneIndex = safeIndex;
    state.sceneVideoStep.lastGeneratedAt = Date.now();
    state.canvas.updatedAt = Date.now();
    if (rerender) {
      renderDetail();
      focusSelectedSceneVideoPreview();
    }
    if (save) scheduleSave();
    return { skipped: false, sceneIndex: selected.sceneIndex, result };
  }

  async function generateAllSceneVideos() {
    const items = getSceneVideoDisplayItems();
    const targets = items.filter((item) => item?.image?.filename && String(item?.prompt || '').trim());
    if (!targets.length) {
      setSceneVideoNotice('先にシーン画像と動画用プロンプトを用意してください', 'warning');
      renderDetail();
      return;
    }
    if (sceneVideoGenerationBusy) return;

    sceneVideoGenerationBusy = true;
    sceneVideoBatchCancelRequested = false;
    let completed = 0;
    let skipped = 0;
    try {
      for (let index = 0; index < items.length; index += 1) {
        if (sceneVideoBatchCancelRequested) break;
        const current = items[index];
        if (!current?.image?.filename || !String(current?.prompt || '').trim()) {
          skipped += 1;
          continue;
        }
        setSceneVideoNotice(`全シーン動画生成中... Scene ${current.sceneIndex} (${completed + 1}/${targets.length})`, 'info');
        renderDetail();
        try {
          await generateSceneVideoAtIndex(index, { rerender: false, save: false });
        } catch (error) {
          if (sceneVideoBatchCancelRequested && isAbortLikeError(error)) {
            break;
          }
          throw error;
        }
        completed += 1;
        setSceneVideoNotice(`シーン${current.sceneIndex} の動画を生成しました。続けて次のシーンを生成します... (${completed}/${targets.length})`, 'info');
        renderDetail();
        focusSelectedSceneVideoPreview();
      }
      state.canvas.updatedAt = Date.now();
      if (sceneVideoBatchCancelRequested) {
        setSceneVideoNotice(`全シーン動画生成を中止しました（成功 ${completed} / スキップ ${skipped}）`, 'info');
      } else {
        setSceneVideoNotice(`全シーン動画を生成しました（成功 ${completed} / スキップ ${skipped}）`, 'success');
      }
      renderDetail();
      scheduleSave();
    } finally {
      sceneVideoGenerationBusy = false;
      sceneVideoBatchCancelRequested = false;
      renderDetail();
    }
  }

  function clearSelectedSceneVideo() {
    const items = getSceneVideoDisplayItems();
    const index = Math.max(0, Number(state.sceneVideoStep.selectedSceneIndex || 0) || 0);
    if (!items[index]) return;
    items[index].video = null;
    syncSceneVideoItems(items);
    invalidateFinalMvOutputs();
    state.canvas.updatedAt = Date.now();
    setSceneVideoNotice(`シーン${items[index].sceneIndex} の動画をクリアしました`, 'info');
    renderDetail();
    scheduleSave();
  }

  async function concatFinalMvClips() {
    const filenames = getFinalMvSceneVideoFilenames();
    if (!filenames.length) {
      setFinalMvNotice('先にシーン動画を生成してください', 'warning');
      renderDetail();
      return;
    }
    if (finalMvRenderBusy) return;

    finalMvRenderBusy = true;
    setFinalMvNotice(`シーンクリップを結合中です... (${filenames.length}本)`, 'info');
    renderDetail();

    try {
      const response = await fetch('/api/v1/production/final-mv/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          video_filenames: filenames,
          fps: Math.max(8, Math.min(32, Number(state.sceneVideoStep.fps) || 16)),
          xfade_transitions: getFinalMvXfadeTransitions(),
          xfade_duration: 0.5,
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      state.finalMvStep.clipVideo = normalizeFinalMvMediaItem(result?.clip_video);
      state.finalMvStep.finalVideo = null;
      state.finalMvStep.lastRenderedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setFinalMvNotice('シーンクリップを結合しました', 'success');
      renderDetail();
      scheduleSave();
    } finally {
      finalMvRenderBusy = false;
      renderDetail();
    }
  }

  async function renderFinalMvVideo() {
    const audioFilename = String(state.musicStep.generatedAudio?.filename || '').trim();
    const clipFilename = String(state.finalMvStep.clipVideo?.filename || '').trim();
    const sceneVideoFilenames = clipFilename ? [] : getFinalMvSceneVideoFilenames();
    if (!clipFilename && !sceneVideoFilenames.length) {
      setFinalMvNotice('先にシーン動画を生成してください', 'warning');
      renderDetail();
      return;
    }
    if (!audioFilename) {
      setFinalMvNotice('先に音楽制作で音声を生成してください', 'warning');
      renderDetail();
      return;
    }
    if (finalMvRenderBusy) return;

    finalMvRenderBusy = true;
    setFinalMvNotice('音楽を合成して完成MVを生成中です...', 'info');
    renderDetail();

    try {
      const response = await fetch('/api/v1/production/final-mv/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          clip_filename: clipFilename,
          video_filenames: sceneVideoFilenames,
          audio_filename: audioFilename,
          fps: Math.max(8, Math.min(32, Number(state.sceneVideoStep.fps) || 16)),
          xfade_transitions: getFinalMvXfadeTransitions(),
          xfade_duration: 0.5,
        }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`HTTP ${response.status}: ${payload}`);
      }
      const result = await response.json();
      state.finalMvStep.clipVideo = normalizeFinalMvMediaItem(result?.clip_video) || state.finalMvStep.clipVideo;
      state.finalMvStep.finalVideo = normalizeFinalMvMediaItem(result?.final_video);
      state.finalMvStep.lastRenderedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setFinalMvNotice('完成MVを生成しました', 'success');
      renderDetail();
      scheduleSave();
    } finally {
      finalMvRenderBusy = false;
      renderDetail();
    }
  }

  async function autoCreateFinalMv() {
    const audioFilename = String(state.musicStep.generatedAudio?.filename || '').trim();
    const sceneVideoFilenames = getFinalMvSceneVideoFilenames();
    const fps = Math.max(8, Math.min(32, Number(state.sceneVideoStep.fps) || 16));
    if (!sceneVideoFilenames.length) {
      setFinalMvNotice('先にシーン動画を生成してください', 'warning');
      renderDetail();
      return;
    }
    if (!audioFilename) {
      setFinalMvNotice('先に音楽制作で音声を生成してください', 'warning');
      renderDetail();
      return;
    }
    if (finalMvRenderBusy) return;

    finalMvRenderBusy = true;
    setFinalMvNotice(`自動制作中です... まずシーンクリップを結合します (${sceneVideoFilenames.length}本)`, 'info');
    renderDetail();

    try {
      const concatResponse = await fetch('/api/v1/production/final-mv/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          video_filenames: sceneVideoFilenames,
          fps,
        }),
      });
      if (!concatResponse.ok) {
        const payload = await concatResponse.text();
        throw new Error(`HTTP ${concatResponse.status}: ${payload}`);
      }
      const concatResult = await concatResponse.json();
      const clipVideo = normalizeFinalMvMediaItem(concatResult?.clip_video);
      const clipFilename = String(clipVideo?.filename || '').trim();
      if (!clipFilename) {
        throw new Error('結合クリップの取得に失敗しました');
      }
      state.finalMvStep.clipVideo = clipVideo;
      state.finalMvStep.finalVideo = null;
      state.canvas.updatedAt = Date.now();
      setFinalMvNotice('シーンクリップを結合しました。続けて音楽を合成しています...', 'info');
      renderDetail();

      const renderResponse = await fetch('/api/v1/production/final-mv/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          clip_filename: clipFilename,
          audio_filename: audioFilename,
          fps,
        }),
      });
      if (!renderResponse.ok) {
        const payload = await renderResponse.text();
        throw new Error(`HTTP ${renderResponse.status}: ${payload}`);
      }
      const renderResult = await renderResponse.json();
      state.finalMvStep.clipVideo = normalizeFinalMvMediaItem(renderResult?.clip_video) || state.finalMvStep.clipVideo;
      state.finalMvStep.finalVideo = normalizeFinalMvMediaItem(renderResult?.final_video);
      state.finalMvStep.lastRenderedAt = Date.now();
      state.canvas.updatedAt = Date.now();
      setFinalMvNotice('自動制作で完成MVを生成しました', 'success');
      renderDetail();
      scheduleSave();
    } finally {
      finalMvRenderBusy = false;
      renderDetail();
    }
  }

  function clearFinalMvResults() {
    invalidateFinalMvOutputs();
    state.canvas.updatedAt = Date.now();
    setFinalMvNotice('完成MV出力をクリアしました', 'info');
    renderDetail();
    scheduleSave();
  }

  function focusSelectedSceneVideoPreview() {
    window.requestAnimationFrame(() => {
      const activeChip = els.detailBody?.querySelector('.scene-video-chip.active');
      const previewBlock = els.detailBody?.querySelector('[data-scene-video-preview-block]');
      activeChip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      previewBlock?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  async function generateSelectedSceneImage() {
    const sceneState = getSceneImageStepState();
    const selected = getSelectedScenePromptItem();
    const prompt = String(selected?.prompt || '').trim();
    if (!prompt) {
      setSceneImageNotice('先に対象シーンのプロンプトを用意してください', 'warning');
      renderDetail();
      return;
    }
    if (sceneImageGenerationBusy) return;

    sceneImageGenerationBusy = true;
    sceneImageBatchCancelRequested = false;
    setSceneImageNotice(`シーン${selected.sceneIndex} の画像を生成中です...`, 'info');
    renderDetail();

    try {
      const result = await requestSceneImageGeneration({
        client_session_id: getSessionId(),
        scene_index: selected.sceneIndex,
        prompt,
        input_images: getSceneImageReferenceFilenames(),
        cfg: Number(sceneState.cfg) || 1.0,
        denoise: Number(sceneState.denoise) || 1.0,
      });
      const prompts = getSceneImageDisplayPrompts();
      const index = Math.max(0, Number(sceneState.selectedSceneIndex || 0) || 0);
      prompts[index].image = {
        filename: String(result?.filename || ''),
        previewUrl: String(result?.preview_url || ''),
        subfolder: String(result?.subfolder || ''),
        type: String(result?.type || 'output'),
        workflow: String(result?.workflow || ''),
        promptId: String(result?.prompt_id || ''),
      };
      state.sceneImageStep.scenePrompts = prompts;
      invalidateSceneVideoAtIndex(index);
      state.canvas.updatedAt = Date.now();
      setSceneImageNotice(`シーン${selected.sceneIndex} の画像を生成しました`, 'success');
      renderDetail();
      scheduleSave();
    } catch (error) {
      if (isAbortLikeError(error)) {
        setSceneImageNotice(`シーン${selected.sceneIndex} の画像生成を中止しました`, 'info');
        renderDetail();
        return;
      }
      throw error;
    } finally {
      sceneImageGenerationBusy = false;
      sceneImageBatchCancelRequested = false;
      renderDetail();
    }
  }

  async function generateSceneImageAtIndex(index, { rerender = true, save = true } = {}) {
    const sceneState = getSceneImageStepState();
    const prompts = getSceneImageDisplayPrompts();
    const safeIndex = Math.max(0, Math.min(Number(index) || 0, prompts.length - 1));
    const selected = prompts[safeIndex] || null;
    const prompt = String(selected?.prompt || '').trim();
    if (!selected || !prompt) {
      return { skipped: true, sceneIndex: selected?.sceneIndex || safeIndex + 1 };
    }

    const result = await requestSceneImageGeneration({
      client_session_id: getSessionId(),
      scene_index: selected.sceneIndex,
      prompt,
      input_images: getSceneImageReferenceFilenames(),
      cfg: Number(sceneState.cfg) || 1.0,
      denoise: Number(sceneState.denoise) || 1.0,
    });
    prompts[safeIndex].image = {
      filename: String(result?.filename || ''),
      previewUrl: String(result?.preview_url || ''),
      subfolder: String(result?.subfolder || ''),
      type: String(result?.type || 'output'),
      workflow: String(result?.workflow || ''),
      promptId: String(result?.prompt_id || ''),
    };
    state.sceneImageStep.scenePrompts = prompts;
    invalidateSceneVideoAtIndex(safeIndex);
    state.sceneImageStep.selectedSceneIndex = safeIndex;
    state.canvas.updatedAt = Date.now();
    if (rerender) {
      renderDetail();
      focusSelectedScenePreview();
    }
    if (save) scheduleSave();
    return { skipped: false, sceneIndex: selected.sceneIndex, result };
  }

  async function generateAllSceneImages() {
    const prompts = getSceneImageDisplayPrompts();
    const targets = prompts.filter((item) => String(item?.prompt || '').trim());
    if (!targets.length) {
      setSceneImageNotice('先にシーンプロンプトを作成してください', 'warning');
      renderDetail();
      return;
    }
    if (sceneImageGenerationBusy) return;

    sceneImageGenerationBusy = true;
    sceneImageBatchCancelRequested = false;
    const total = prompts.length;
    let completed = 0;
    let skipped = 0;
    try {
      for (let index = 0; index < prompts.length; index += 1) {
        if (sceneImageBatchCancelRequested) break;
        const current = prompts[index];
        if (!String(current?.prompt || '').trim()) {
          skipped += 1;
          continue;
        }
        state.sceneImageStep.selectedSceneIndex = index;
        setSceneImageNotice(`全シーン画像生成中... (${completed + 1}/${targets.length})`, 'info');
        renderDetail();
        focusSelectedScenePreview();
        try {
          await generateSceneImageAtIndex(index, { rerender: false, save: false });
        } catch (error) {
          if (sceneImageBatchCancelRequested && isAbortLikeError(error)) {
            break;
          }
          throw error;
        }
        completed += 1;
        renderDetail();
        focusSelectedScenePreview();
      }
      state.canvas.updatedAt = Date.now();
      if (sceneImageBatchCancelRequested) {
        setSceneImageNotice(`全シーン画像生成を中止しました（成功 ${completed} / スキップ ${skipped}）`, 'info');
      } else {
        setSceneImageNotice(`全シーン画像を生成しました（成功 ${completed} / スキップ ${skipped}）`, 'success');
      }
      renderDetail();
      scheduleSave();
    } finally {
      sceneImageGenerationBusy = false;
      sceneImageBatchCancelRequested = false;
      if (!completed && skipped < total) {
        renderDetail();
      }
    }
  }

  function clearSelectedSceneImage() {
    const prompts = getSceneImageDisplayPrompts();
    const index = Math.max(0, Number(state.sceneImageStep.selectedSceneIndex || 0) || 0);
    if (!prompts[index]) return;
    prompts[index].image = null;
    state.sceneImageStep.scenePrompts = prompts;
    invalidateSceneVideoAtIndex(index);
    state.canvas.updatedAt = Date.now();
    setSceneImageNotice(`シーン${prompts[index].sceneIndex} の画像をクリアしました`, 'info');
    renderDetail();
    scheduleSave();
  }

  function focusSelectedScenePreview() {
    window.requestAnimationFrame(() => {
      const activeChip = els.detailBody?.querySelector('.scene-prompt-chip.active');
      const previewBlock = els.detailBody?.querySelector('[data-scene-preview-block]');
      activeChip?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      previewBlock?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  function renderStoryWorkspace(step, mode) {
    const storyState = getStoryStepState();
    const preset = getPresetById();
    const pipeline = getSelectedPipelineOption(preset);
    const notice = storyState.notice;
    const characterContext = getStoryCharacterContext();
    const storyTitle = String(step?.title || 'シナリオ・世界観作成');
    const isLyricsFocused = storyTitle.includes('歌詞');
    const ideaLabel = isLyricsFocused ? '歌詞・構成メモ' : 'ざっくり意図';
    const ideaHelp = isLyricsFocused
      ? '歌詞ブロック、見せ場、情景キーワード、感情の流れを短く書きます。'
      : 'MVのテーマ、舞台、感情の流れ、見せ場を短く書きます。';
    const ideaPlaceholder = isLyricsFocused
      ? '例: Aメロは雨の駅、Bメロで回想、サビで夜明けと解放感を見せる'
      : '例: 夜の都会を舞台に、孤独な主人公が光を見つけて前へ進むMV';
    const worldLabel = isLyricsFocused ? '情景・世界観メモ' : '世界観メモ';
    const worldHelp = isLyricsFocused
      ? '歌詞に紐づく舞台、色調、反復モチーフ、映像で避けたい表現を整理します。'
      : '舞台設定、時代、色調、反復モチーフ、禁止事項などを整理します。';
    const scenarioLabel = isLyricsFocused ? '歌詞・構成ドラフト' : 'シナリオ全文';
    const scenarioHelp = isLyricsFocused
      ? '歌詞・構成・演出メモをまとめた、後続STEPへ渡す基礎テキストです。'
      : '後続の音楽作成・シーン画像作成へ渡す基礎テキストです。';
    const generateLabel = isLyricsFocused ? '🧠 歌詞・構成を作成' : '🧠 シナリオ作成';
    const generateBusyLabel = isLyricsFocused ? '⏳ 作成中...' : '⏳ 生成中...';
    const lastGeneratedText = storyState.lastGeneratedAt ? formatDateTime(storyState.lastGeneratedAt) : '未生成';
    const deferredPromptMemo = isLyricsFocused
      ? 'シーン画像用の個別プロンプトは、音楽作成で歌詞を確定した後に「シーン画像作成」エリアで生成します。'
      : '各シーンの画像プロンプトは、この段階ではまだ作らず、音楽作成で歌詞を確定した後に「シーン画像作成」エリアで生成します。';

    return `
      <div class="detail-layout">
        <div class="detail-grid">
          <section class="detail-highlight">
            <div class="detail-summary-row">
              <div>
                <div class="canvas-label">STEPの役割</div>
                <h3>${escapeHtml(step.title)}</h3>
              </div>
              <span class="flow-mini-badge">${escapeHtml(step.short || '')}</span>
            </div>
            <p>${escapeHtml(step.objective || '')}</p>
            ${notice ? `<div class="character-inline-notice ${escapeHtml(notice.tone || 'info')}">${escapeHtml(notice.message || '')}</div>` : ''}
            <div class="story-meta-grid">
              <label class="preset-select-group">
                <span class="field-label">ジャンル</span>
                <input id="storyGenreInput" class="text-input" type="text" placeholder="例: エモーショナル / シティポップ / ダークファンタジー" value="${escapeHtml(storyState.genre || '')}" />
              </label>
              <label class="preset-select-group">
                <span class="field-label">想定尺（秒）</span>
                <input id="storyDurationInput" class="text-input" type="number" min="10" max="600" step="5" value="${escapeHtml(storyState.targetDurationSec || 30)}" />
              </label>
              <label class="preset-select-group">
                <span class="field-label">シーン数</span>
                <input id="storySceneCountInput" class="text-input" type="number" min="1" max="40" step="1" value="${escapeHtml(storyState.sceneCount || 5)}" />
              </label>
            </div>
            <ul class="detail-list">
              <li><strong>制作フロープラン</strong>${escapeHtml(pipeline?.label || '未選択')}</li>
              <li><strong>フロープラン要点</strong>${escapeHtml(pipeline?.description || '現在の入口プリセットに応じた標準フローを利用します。')}</li>
              <li><strong>最終作成日時</strong>${escapeHtml(lastGeneratedText)}</li>
            </ul>
            <div class="character-ref-options">
              <label class="character-inline-option">
                <input id="storyLyricsEnabled" type="checkbox" ${storyState.lyricsEnabled ? 'checked' : ''} />
                <span>歌詞やナレーションを前提にする</span>
              </label>
              <label class="character-inline-option">
                <input id="storyUseCharacterContext" type="checkbox" ${storyState.useCharacterContext ? 'checked' : ''} ${characterContext ? '' : 'disabled'} />
                <span>キャラクタ作成エリアの情報を反映</span>
              </label>
            </div>
          </section>

          <section class="detail-block">
            <h3>${escapeHtml(ideaLabel)}</h3>
            <p class="field-help">${escapeHtml(ideaHelp)}</p>
            <textarea id="storyIdeaInput" data-story-field="idea" class="prompt-textarea" rows="4" placeholder="${escapeHtml(ideaPlaceholder)}">${escapeHtml(storyState.idea || '')}</textarea>
            <div class="character-ref-options">
              <button id="storyIdeaTranslateBtn" data-story-translate="idea" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
              <button id="storyGenerateBtn" class="detail-action-btn primary" type="button" ${storyGenerationBusy ? 'disabled' : ''}>${storyGenerationBusy ? generateBusyLabel : generateLabel}</button>
              <button id="storyUseCharacterContextBtn" class="detail-action-btn secondary" type="button" ${characterContext ? '' : 'disabled'}>キャラ情報を反映</button>
            </div>
          </section>

          <section class="detail-block">
            <h3>${escapeHtml(worldLabel)}</h3>
            <p class="field-help">${escapeHtml(worldHelp)}</p>
            <textarea id="storyWorldNotesInput" data-story-field="worldNotes" class="prompt-textarea" rows="5" placeholder="例: ネオン街、雨上がり、青紫の逆光、サビで夜明けへ移行...">${escapeHtml(storyState.worldNotes || '')}</textarea>
            <div class="character-ref-options">
              <button id="storyWorldNotesTranslateBtn" data-story-translate="worldNotes" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
            </div>
          </section>
        </div>

        <div class="detail-grid">
          <section class="detail-block">
            <h3>${escapeHtml(scenarioLabel)}</h3>
            <p class="field-help">${escapeHtml(scenarioHelp)}</p>
            <textarea id="storyScenarioText" data-story-field="scenarioText" class="prompt-textarea story-scenario-textarea" rows="10" placeholder="シナリオ作成を実行すると、ここに展開結果が入ります。">${escapeHtml(storyState.scenarioText || '')}</textarea>
            <div class="character-ref-options">
              <button id="storyScenarioTranslateBtn" data-story-translate="scenarioText" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
              ${storyState.scenarioText ? '<button id="storyScenarioClearBtn" class="detail-action-btn secondary" type="button">クリア</button>' : ''}
            </div>
          </section>

          <section class="detail-block">
            <h3>後続STEPメモ</h3>
            <p class="field-help">${escapeHtml(deferredPromptMemo)}</p>
            <ul class="story-outline-list">
              <li>このSTEPでは、世界観・感情曲線・構成方針までを整理します。</li>
              <li>音楽作成STEPで、尺・盛り上がり位置・歌詞を確定させます。</li>
              <li>シーン画像作成STEPで、シナリオ + 歌詞 + キャラクタ情報を使って各シーンの画像プロンプトを生成します。</li>
              <li>現在の目安: ${escapeHtml(String(storyState.sceneCount || 5))}シーン / ${escapeHtml(String(storyState.targetDurationSec || 30))}秒</li>
            </ul>
          </section>

          <section class="detail-block">
            <h3>次STEPへの受け渡し</h3>
            <ul class="detail-list">
              <li><strong>音楽作成へ</strong>${escapeHtml(storyState.scenarioText ? '尺・感情曲線・歌詞方針・世界観メモを渡す' : 'シナリオ作成後に受け渡し')}</li>
              <li><strong>シーン画像作成へ</strong>${escapeHtml(storyState.scenarioText ? '音楽作成で確定した歌詞を加えてシーン画像プロンプトを生成' : '先にシナリオと音楽情報を準備')}</li>
              <li><strong>キャラクタ作成からの反映</strong>${escapeHtml(characterContext ? 'キャラ文脈あり' : '未反映')}</li>
            </ul>
          </section>

          <section class="mode-note">
            <strong>${escapeHtml(mode?.label || '自動制作')}時の見せ方</strong>
            <p>${escapeHtml(getModeSpecificHint(state.mode, step))}</p>
          </section>
        </div>
      </div>
    `;
  }

  function renderMusicWorkspace(step, mode) {
    const musicState = getMusicStepState();
    const storyState = getStoryStepState();
    const preset = getPresetById();
    const pipeline = getSelectedPipelineOption(preset);
    const notice = musicState.notice;
    const storyContext = getMusicStoryContext();
    const characterContext = getStoryCharacterContext();
    const isLyricsFocused = String(preset?.id || '') === 'lyrics_focus_mv';
    const titleText = musicState.lastGeneratedAt ? formatDateTime(musicState.lastGeneratedAt) : '未生成';
    const effectiveDurationSec = getEffectiveMusicDurationSec();
    const durationInherited = !hasMusicDurationOverride();
    const generatedAudio = musicState.generatedAudio;
    const audioSourceBaseLabel = generatedAudio?.source === 'imported' ? '外部音楽' : '生成音楽';
    const audioSourceLabel = String(generatedAudio?.backend || '').includes('trim') ? `${audioSourceBaseLabel} / トリミング済み` : audioSourceBaseLabel;
    const audioDurationLabel = generatedAudio?.durationSec ? `${Math.round(Number(generatedAudio.durationSec) || 0)}秒` : '';
    const trimRange = getMusicAudioTrimRange();

    return `
      <div class="detail-layout">
        <div class="detail-grid">
          <section class="detail-highlight">
            <div class="detail-summary-row">
              <div>
                <div class="canvas-label">STEPの役割</div>
                <h3>${escapeHtml(step.title)}</h3>
              </div>
              <span class="flow-mini-badge">${escapeHtml(step.short || '')}</span>
            </div>
            <p>${escapeHtml(step.objective || '')}</p>
            ${notice ? `<div class="character-inline-notice ${escapeHtml(notice.tone || 'info')}">${escapeHtml(notice.message || '')}</div>` : ''}
            <div class="story-meta-grid">
              <label class="preset-select-group">
                <span class="field-label">制作尺（秒）</span>
                <input id="musicTargetDurationInput" class="text-input" type="number" min="10" max="600" step="5" value="${escapeHtml(storyState.targetDurationSec || 30)}" />
              </label>
              <label class="preset-select-group">
                <span class="field-label">歌唱言語</span>
                <select id="musicVocalLanguageSelect" class="select-input compact-select">
                  <option value="ja" ${musicState.vocalLanguage === 'ja' ? 'selected' : ''}>日本語</option>
                  <option value="en" ${musicState.vocalLanguage === 'en' ? 'selected' : ''}>English</option>
                  <option value="inst" ${musicState.vocalLanguage === 'inst' ? 'selected' : ''}>インスト中心</option>
                </select>
              </label>
              <label class="preset-select-group">
                <span class="field-label">BPM</span>
                <input id="musicBpmInput" class="text-input" type="number" min="60" max="220" step="1" value="${escapeHtml(musicState.bpm || 118)}" />
              </label>
              <label class="preset-select-group">
                <span class="field-label">音楽尺上書き（秒）</span>
                <input id="musicDurationOverrideInput" class="text-input" type="number" min="10" max="600" step="5" value="${musicState.durationOverrideSec ? escapeHtml(musicState.durationOverrideSec) : ''}" placeholder="未入力なら前段を継承" />
              </label>
              <label class="preset-select-group">
                <span class="field-label">キー</span>
                <input id="musicKeyInput" class="text-input" type="text" placeholder="例: C major / A minor" value="${escapeHtml(musicState.keySignature || '')}" />
              </label>
            </div>
            <ul class="detail-list">
              <li><strong>制作フロープラン</strong>${escapeHtml(pipeline?.label || '未選択')}</li>
              <li><strong>参照シナリオ</strong>${escapeHtml(storyState.scenarioText ? 'あり' : '未準備')}</li>
              <li><strong>基準尺</strong>${escapeHtml(`${storyState.targetDurationSec || 30}秒`)}</li>
              <li><strong>使用する長さ</strong>${escapeHtml(`${effectiveDurationSec}秒${durationInherited ? '（前段を継承）' : '（音楽作成で上書き）'}`)}</li>
              <li><strong>最終作成日時</strong>${escapeHtml(titleText)}</li>
            </ul>
            <div class="character-ref-options">
              <label class="character-inline-option">
                <input id="musicHasVocals" type="checkbox" ${musicState.hasVocals ? 'checked' : ''} ${musicState.vocalLanguage === 'inst' ? 'disabled' : ''} />
                <span>歌詞を含む楽曲にする</span>
              </label>
              <label class="character-inline-option">
                <input id="musicInstrumentalFocus" type="checkbox" ${musicState.instrumentalFocus ? 'checked' : ''} />
                <span>インストの印象を強める</span>
              </label>
              <label class="character-inline-option">
                <input id="musicUseStoryContext" type="checkbox" ${musicState.useStoryContext ? 'checked' : ''} ${storyContext ? '' : 'disabled'} />
                <span>シナリオ・世界観を参照</span>
              </label>
              <label class="character-inline-option">
                <input id="musicUseCharacterContext" type="checkbox" ${musicState.useCharacterContext ? 'checked' : ''} ${characterContext ? '' : 'disabled'} />
                <span>キャラクタ情報を参照</span>
              </label>
            </div>
          </section>

          <section class="detail-block">
            <h3>${escapeHtml(isLyricsFocused ? '曲の方向性・歌詞フック' : '曲の方向性メモ')}</h3>
            <p class="field-help">シナリオから受け取った感情曲線を、曲調・声質・展開・サビの見せ場に変換するためのメモです。</p>
            <textarea id="musicPromptInput" data-music-field="musicPrompt" class="prompt-textarea" rows="6" placeholder="例: Aメロは静かに、サビで解放感。雨の夜から夜明けへ抜けるようなシティポップ感。">${escapeHtml(musicState.musicPrompt || '')}</textarea>
            <div class="character-ref-options">
              <button id="musicProduceBtn" class="detail-action-btn primary" type="button" ${musicAudioGenerationBusy ? 'disabled' : ''}>${musicAudioGenerationBusy ? '⏳ 音楽生成中...' : '🎵 音楽制作'}</button>
              <button id="musicGenerateBtn" class="detail-action-btn secondary" type="button" ${musicPlanGenerationBusy ? 'disabled' : ''}>${musicPlanGenerationBusy ? '⏳ 生成中...' : '🧠 歌詞・楽曲プラン作成'}</button>
              <button id="musicImportAudioBtn" class="detail-action-btn secondary" type="button">📥 外部音楽を読み込む</button>
              <button id="musicPromptTranslateBtn" data-music-translate="musicPrompt" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
              <button id="musicUseStoryContextBtn" class="detail-action-btn secondary" type="button" ${storyContext ? '' : 'disabled'}>シナリオ内容を反映</button>
              <input id="musicImportAudioInput" type="file" accept="audio/*" hidden />
            </div>
            <div class="character-ref-options">
              <label class="character-inline-option">
                <input id="musicAutoSuggestScenePlanOnImport" type="checkbox" ${musicState.autoSuggestScenePlanOnImport !== false ? 'checked' : ''} />
                <span>外部音楽読込後にシーン尺・遷移も自動提案</span>
              </label>
            </div>
          </section>

          <section class="detail-block">
            <h3>確定歌詞</h3>
            <p class="field-help">この歌詞が後続のシーン画像作成で重要な参照になります。必要なら手動で編集します。</p>
            <textarea id="musicLyricsText" data-music-field="lyricsText" class="prompt-textarea music-lyrics-textarea" rows="10" placeholder="歌詞・楽曲プラン作成を実行すると、ここに歌詞案が入ります。">${escapeHtml(musicState.lyricsText || '')}</textarea>
            <div class="character-ref-options">
              <button id="musicLyricsTranslateBtn" data-music-translate="lyricsText" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
              ${musicState.lyricsText ? '<button id="musicPlanClearBtn" class="detail-action-btn secondary" type="button">クリア</button>' : ''}
            </div>
          </section>
        </div>

        <div class="detail-grid">
          <section class="detail-block">
            <h3>音楽タグ / 楽曲プロンプト</h3>
            <p class="field-help">ACE-Step 等でそのまま使う想定のタグ群です。ジャンル、BPM、楽器、声質、ムードを含めます。</p>
            <textarea id="musicTagsText" data-music-field="tagsText" class="prompt-textarea" rows="6" placeholder="例: city pop, emotional, female vocal, 118 bpm, shimmering synth, cinematic">${escapeHtml(musicState.tagsText || '')}</textarea>
            <div class="character-ref-options">
              <button id="musicTagsTranslateBtn" data-music-translate="tagsText" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
            </div>
          </section>

          <section class="detail-block">
            <h3>アレンジメモ</h3>
            <p class="field-help">盛り上がり位置、Aメロ/サビの役割、楽器の出入り、シーン画像作成へ渡したい歌詞の使い方を整理します。</p>
            <textarea id="musicArrangementNotesInput" data-music-field="arrangementNotes" class="prompt-textarea" rows="8" placeholder="例: 0-10秒は導入、サビ頭でキックを強める。サビ1行目を夜明けカットへ使う。">${escapeHtml(musicState.arrangementNotes || '')}</textarea>
            <div class="character-ref-options">
              <button id="musicArrangementTranslateBtn" data-music-translate="arrangementNotes" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
            </div>
          </section>

          <section class="detail-block">
            <h3>生成済み音声</h3>
            <p class="field-help">音楽制作または外部音楽読み込みを行うと、ここで音声を確認できます。</p>
            ${generatedAudio?.previewUrl ? `
              <div class="character-output-card">
                <div class="character-output-meta">
                  <strong>${escapeHtml(generatedAudio.originalName || generatedAudio.filename || 'generated audio')}</strong>
                  <span>${escapeHtml(audioSourceLabel)} / ${escapeHtml(audioDurationLabel || generatedAudio.backend || 'audio')}</span>
                </div>
                <div class="music-audio-player-wrap">
                  <audio id="musicAudioPlayer" controls preload="metadata" class="music-audio-player" src="${escapeHtml(generatedAudio.previewUrl)}"></audio>
                </div>
                <div class="music-waveform-block">
                  <div class="music-waveform-canvas-wrap">
                    <canvas id="musicTrimWaveformCanvas" class="music-waveform-canvas" height="180"></canvas>
                    <div id="musicTrimWaveformEmpty" class="music-waveform-empty">波形を読み込み中...</div>
                  </div>
                  <div id="musicTrimPlaybackStatus" class="music-trim-playback-status">再生位置 0.0 / ${escapeHtml(trimRange.durationSec.toFixed(1))} 秒</div>
                  <div class="music-trim-slider-grid">
                    <label class="preset-select-group">
                      <span class="field-label">開始スライダー</span>
                      <input id="musicTrimStartRange" class="music-trim-range" type="range" min="0" max="${escapeHtml(trimRange.durationSec.toFixed(1))}" step="0.1" value="${escapeHtml(trimRange.startSec.toFixed(1))}" />
                    </label>
                    <label class="preset-select-group">
                      <span class="field-label">終了スライダー</span>
                      <input id="musicTrimEndRange" class="music-trim-range" type="range" min="0" max="${escapeHtml(trimRange.durationSec.toFixed(1))}" step="0.1" value="${escapeHtml(trimRange.endSec.toFixed(1))}" />
                    </label>
                  </div>
                </div>
                <div class="music-trim-grid">
                  <label class="preset-select-group">
                    <span class="field-label">残す開始位置（秒）</span>
                    <input id="musicTrimStartInput" class="text-input" type="number" min="0" max="${escapeHtml(trimRange.durationSec.toFixed(1))}" step="0.1" value="${escapeHtml(trimRange.startSec.toFixed(1))}" />
                  </label>
                  <label class="preset-select-group">
                    <span class="field-label">残す終了位置（秒）</span>
                    <input id="musicTrimEndInput" class="text-input" type="number" min="0" max="${escapeHtml(trimRange.durationSec.toFixed(1))}" step="0.1" value="${escapeHtml(trimRange.endSec.toFixed(1))}" />
                  </label>
                </div>
                <p id="musicTrimSummary" class="field-help music-trim-summary">元音声 ${escapeHtml(trimRange.durationSec.toFixed(1))} 秒 / 採用区間 ${escapeHtml(trimRange.keepDurationSec.toFixed(1))} 秒。不要部分を削って、今の音声を短くできます。</p>
                <div class="character-ref-options">
                  <button id="musicAudioTrimBtn" class="detail-action-btn secondary compact" type="button" ${musicAudioTrimBusy ? 'disabled' : ''}>${musicAudioTrimBusy ? '⏳ トリミング中...' : '✂️ トリミング'}</button>
                  <button id="musicAudioClearBtn" class="detail-action-btn secondary compact" type="button">クリア</button>
                </div>
              </div>
            ` : '<p class="field-help">まだ音声は設定されていません。</p>'}
          </section>

          <section class="detail-block">
            <h3>次STEPへの受け渡し</h3>
            <ul class="detail-list">
              <li><strong>曲名メモ</strong>${escapeHtml(musicState.title || '未設定')}</li>
              <li><strong>シーン画像作成へ</strong>${escapeHtml(musicState.lyricsText ? '確定歌詞 + 音楽タグ + アレンジメモを渡す' : '歌詞または音楽メモの確定待ち')}</li>
              <li><strong>シーン動画作成へ</strong>${escapeHtml(musicState.bpm ? `BPM ${musicState.bpm} を基準に尺感を調整` : 'BPM未設定')}</li>
              <li><strong>音声素材</strong>${escapeHtml(generatedAudio?.originalName || generatedAudio?.filename || '未生成')}</li>
              <li><strong>補足</strong>${escapeHtml(isLyricsFocused ? '歌詞の見せ場を各シーンへ割り当てる前提です。' : '必要に応じてインスト主体にも切り替えられます。')}</li>
            </ul>
            <div class="character-ref-options">
              <button id="musicScenePlanSuggestBtn" class="detail-action-btn secondary" type="button" ${scenePlanGenerationBusy ? 'disabled' : ''}>${scenePlanGenerationBusy ? '⏳ 尺提案中...' : '🧩 この長さでシーン尺を再提案'}</button>
            </div>
          </section>

          <section class="mode-note">
            <strong>${escapeHtml(mode?.label || '自動制作')}時の見せ方</strong>
            <p>${escapeHtml(getModeSpecificHint(state.mode, step))}</p>
          </section>
        </div>
      </div>
    `;
  }

  function renderSceneImageWorkspace(step, mode) {
    const sceneState = getSceneImageStepState();
    const storyState = getStoryStepState();
    const musicState = getMusicStepState();
    const preset = getPresetById();
    const pipeline = getSelectedPipelineOption(preset);
    const notice = sceneState.notice;
    const prompts = getSceneImageDisplayPrompts();
    const selected = getSelectedScenePromptItem() || prompts[0] || null;
    const promptGeneratedAt = sceneState.lastPromptGeneratedAt ? formatDateTime(sceneState.lastPromptGeneratedAt) : '未生成';
    const referenceFiles = getSceneImageReferenceFilenames();
    const selectedIndex = Math.max(0, Number(sceneState.selectedSceneIndex || 0) || 0);
    const sceneTabs = prompts.map((item, index) => `
      <button class="scene-prompt-chip ${index === selectedIndex ? 'active' : ''}" type="button" data-scene-select="${index}">
        <div class="scene-prompt-chip-thumb-wrap">
          ${item.image?.previewUrl
            ? `<img class="scene-prompt-chip-thumb" src="${escapeHtml(item.image.previewUrl)}" alt="scene ${escapeHtml(item.sceneIndex || index + 1)} thumbnail" loading="lazy" />`
            : `<div class="scene-prompt-chip-thumb placeholder">${item.prompt ? '📝' : '🎬'}</div>`}
        </div>
        <strong>Scene ${escapeHtml(item.sceneIndex || index + 1)}</strong>
        <span>${escapeHtml(item.durationSec ? `${item.durationSec}s` : '未割当')}</span>
        <span>${escapeHtml(index === 0 ? '先頭シーン' : `遷移: ${getSceneTransitionLabel(item.transitionType)}`)}</span>
        <span>${item.image?.previewUrl ? '🖼️ 生成済み' : (item.prompt ? '📝 プロンプト済み' : '未作成')}</span>
      </button>
    `).join('');

    return `
      <div class="detail-layout">
        <div class="detail-grid">
          <section class="detail-highlight">
            <div class="detail-summary-row">
              <div>
                <div class="canvas-label">STEPの役割</div>
                <h3>${escapeHtml(step.title)}</h3>
              </div>
              <span class="flow-mini-badge">${escapeHtml(step.short || '')}</span>
            </div>
            <p>${escapeHtml(step.objective || '')}</p>
            ${notice ? `<div class="character-inline-notice ${escapeHtml(notice.tone || 'info')}">${escapeHtml(notice.message || '')}</div>` : ''}
            <div class="story-meta-grid">
              <label class="preset-select-group">
                <span class="field-label">シーン数</span>
                <input id="sceneImageSceneCountInput" class="text-input" type="number" min="1" max="40" step="1" value="${escapeHtml(getSceneImageTargetSceneCount())}" />
              </label>
              <label class="preset-select-group">
                <span class="field-label">参照尺</span>
                <input class="text-input" type="text" value="${escapeHtml(`${getSceneImageEffectiveDurationSec()}秒`) }" disabled />
              </label>
              <label class="preset-select-group">
                <span class="field-label">最終作成日時</span>
                <input class="text-input" type="text" value="${escapeHtml(promptGeneratedAt)}" disabled />
              </label>
            </div>
            <ul class="detail-list">
              <li><strong>制作フロープラン</strong>${escapeHtml(pipeline?.label || '未選択')}</li>
              <li><strong>シナリオ参照</strong>${escapeHtml(storyState.scenarioText ? 'あり' : '未準備')}</li>
              <li><strong>歌詞参照</strong>${escapeHtml(musicState.lyricsText ? 'あり' : '未準備')}</li>
              <li><strong>画像参照</strong>${escapeHtml(referenceFiles.length ? `${referenceFiles.length}枚` : 'なし（T2I扱い）')}</li>
            </ul>
            <div class="character-ref-options">
              <label class="character-inline-option">
                <input id="sceneUseStoryContext" type="checkbox" ${sceneState.useStoryContext ? 'checked' : ''} ${storyState.scenarioText || storyState.worldNotes ? '' : 'disabled'} />
                <span>シナリオ・世界観を参照</span>
              </label>
              <label class="character-inline-option">
                <input id="sceneUseMusicContext" type="checkbox" ${sceneState.useMusicContext ? 'checked' : ''} ${musicState.lyricsText || musicState.arrangementNotes || musicState.tagsText ? '' : 'disabled'} />
                <span>歌詞・音楽メモを参照</span>
              </label>
              <label class="character-inline-option">
                <input id="sceneUseCharacterContext" type="checkbox" ${sceneState.useCharacterContext ? 'checked' : ''} ${getStoryCharacterContext() ? '' : 'disabled'} />
                <span>キャラクタ情報を参照</span>
              </label>
            </div>
          </section>

          <section class="detail-block">
            <h3>シーンプロンプト作成</h3>
            <p class="field-help">シナリオ・確定歌詞・キャラクタ情報から、各シーンごとの静止画向けプロンプトをまとめて作成します。</p>
            <p class="field-help">${escapeHtml(getPipelineTransitionGuidance(String(state.selectedPipelinePresetId || ''), getSelectedSceneVideoWorkflowMode()))}</p>
            <div class="character-ref-options">
              <button id="scenePromptGenerateBtn" class="detail-action-btn primary" type="button" ${scenePromptGenerationBusy ? 'disabled' : ''}>${scenePromptGenerationBusy ? '⏳ シーンプロンプト生成中...' : '🤖 シーンプロンプト作成'}</button>
              <button id="scenePlanSuggestBtn" class="detail-action-btn secondary" type="button" ${(scenePromptGenerationBusy || scenePlanGenerationBusy) ? 'disabled' : ''}>${scenePlanGenerationBusy ? '⏳ 提案中...' : '🧩 尺・遷移を自動提案'}</button>
              ${sceneState.scenePrompts.length ? '<button id="scenePromptClearBtn" class="detail-action-btn secondary" type="button">クリア</button>' : ''}
            </div>
          </section>

          <section class="detail-block">
            <h3>シーン一覧</h3>
            <div class="scene-prompt-chip-grid">${sceneTabs}</div>
          </section>
        </div>

        <div class="detail-grid">
          <section class="detail-block">
            <h3>${escapeHtml(selected ? `Scene ${selected.sceneIndex} プロンプト` : 'シーンプロンプト')}</h3>
            <p class="field-help">英語プロンプト推奨です。必要なら手動で微調整し、そのシーンだけ再生成できます。</p>
            <textarea id="scenePromptText" class="prompt-textarea scene-prompt-textarea" rows="10" placeholder="シーンプロンプト作成を実行すると、ここに選択シーンの内容が入ります。">${escapeHtml(selected?.prompt || '')}</textarea>
            <div class="character-ref-options">
              <button id="scenePromptTranslateBtn" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
            </div>
            <div class="scene-prompt-meta-grid">
              <label class="scene-prompt-meta-card scene-prompt-meta-card-editable">
                <strong>シーン尺（秒）</strong>
                <input id="scenePromptDurationInput" class="text-input scene-meta-input" type="number" min="1" max="15" step="1" value="${escapeHtml(selected?.durationSec || 5)}" />
              </label>
              <div class="scene-prompt-meta-card"><strong>歌詞フック</strong><span>${escapeHtml(selected?.lyricExcerpt || '未割当')}</span></div>
            </div>
            <p class="field-help">${escapeHtml(selected ? getSceneTransitionDescription(selected.transitionType, { sceneIndex: selected.sceneIndex, pipelinePresetId: String(state.selectedPipelinePresetId || ''), workflowMode: getSelectedSceneVideoWorkflowMode() }) : '遷移提案は後続STEPで確認・微調整できます。')}</p>
            <p class="field-help">${escapeHtml(selected?.transitionReason || '遷移理由は自動提案後に表示されます。')}</p>
          </section>

          <section class="detail-block" data-scene-preview-block>
            <h3>${escapeHtml(selected ? `Scene ${selected.sceneIndex} 画像` : 'シーン画像')}</h3>
            <p class="field-help">キャラ合成画像・キャラシート・参照画像があればI2I、なければT2Iで生成します。</p>
            <div class="character-ref-options">
              <button id="sceneImageGenerateAllBtn" class="detail-action-btn secondary" type="button" ${sceneImageGenerationBusy ? 'disabled' : ''}>${sceneImageGenerationBusy ? '⏳ 画像生成中...' : '🖼️ 全シーン画像生成'}</button>
              <button id="sceneImageGenerateBtn" class="detail-action-btn primary" type="button" ${sceneImageGenerationBusy ? 'disabled' : ''}>${sceneImageGenerationBusy ? '⏳ 画像生成中...' : '🖼️ このシーン画像を生成'}</button>
              ${sceneImageGenerationBusy ? '<button id="sceneImageCancelBtn" class="detail-action-btn secondary" type="button">⏹️ 中止</button>' : ''}
              ${selected?.image?.previewUrl ? '<button id="sceneImageClearBtn" class="detail-action-btn secondary" type="button">クリア</button>' : ''}
            </div>
            <div class="character-output-card">
              ${selected?.image?.previewUrl ? `
                <button class="character-output-preview-btn" type="button" data-preview-image="${escapeHtml(selected.image.previewUrl)}" data-preview-title="${escapeHtml(selected.image.filename || `scene-${selected.sceneIndex}.png`)}" aria-label="シーン画像を拡大表示">
                  <img src="${escapeHtml(selected.image.previewUrl)}" alt="scene ${escapeHtml(selected.sceneIndex)}" />
                </button>
                <div class="character-output-meta">${escapeHtml(selected.image.filename || `scene-${selected.sceneIndex}.png`)}</div>
              ` : '<div class="character-output-placeholder">まだこのシーン画像は生成されていません</div>'}
            </div>
          </section>

          <section class="detail-block">
            <h3>次STEPへの受け渡し</h3>
            <ul class="detail-list">
              <li><strong>シーン動画作成へ</strong>${escapeHtml(selected?.image?.filename ? '採用したシーン画像を開始フレーム候補として渡す' : 'まず採用画像を作成')}</li>
              <li><strong>歌詞との同期</strong>${escapeHtml(musicState.lyricsText ? '歌詞フック付きで割り当て済み' : '歌詞未確定のため補完前提')}</li>
              <li><strong>参照画像</strong>${escapeHtml(referenceFiles.length ? referenceFiles.join(' / ') : 'なし')}</li>
            </ul>
          </section>

          <section class="mode-note">
            <strong>${escapeHtml(mode?.label || '自動制作')}時の見せ方</strong>
            <p>${escapeHtml(getModeSpecificHint(state.mode, step))}</p>
          </section>
        </div>
      </div>
    `;
  }

  function renderSceneVideoWorkspace(step, mode) {
    const sceneVideoState = getSceneVideoStepState();
    const preset = getPresetById();
    const pipeline = getSelectedPipelineOption(preset);
    const notice = sceneVideoState.notice;
    const items = getSceneVideoDisplayItems();
    const selected = getSelectedSceneVideoItem() || items[0] || null;
    const selectedIndex = Math.max(0, Number(sceneVideoState.selectedSceneIndex || 0) || 0);
    const lastGeneratedText = sceneVideoState.lastGeneratedAt ? formatDateTime(sceneVideoState.lastGeneratedAt) : '未生成';
    const workflowMode = String(sceneVideoState.workflowMode || getDefaultSceneVideoWorkflowMode() || 'auto');
    const isLtxWorkflow = isLtxSceneVideoWorkflowMode(workflowMode);
    const sceneTabs = items.map((item, index) => `
      <button class="scene-prompt-chip scene-video-chip ${index === selectedIndex ? 'active' : ''}" type="button" data-scene-video-select="${index}">
        <div class="scene-prompt-chip-thumb-wrap">
          ${item.image?.previewUrl
            ? `<img class="scene-prompt-chip-thumb" src="${escapeHtml(item.image.previewUrl)}" alt="scene ${escapeHtml(item.sceneIndex || index + 1)} source" loading="lazy" />`
            : '<div class="scene-prompt-chip-thumb placeholder">🖼️</div>'}
        </div>
        <strong>Scene ${escapeHtml(item.sceneIndex || index + 1)}</strong>
        <span>${escapeHtml(item.durationSec ? `${item.durationSec}s / ${sceneVideoState.fps}fps` : `${sceneVideoState.fps}fps`)}</span>
        <span>${escapeHtml(index === 0 ? '先頭シーン' : `遷移: ${getSceneTransitionLabel(item.transitionType)}`)}</span>
        <span>${item.video?.previewUrl ? '🎬 生成済み' : (item.image?.previewUrl ? '🖼️ 画像準備済み' : '画像未準備')}</span>
      </button>
    `).join('');

    return `
      <div class="detail-layout">
        <div class="detail-grid">
          <section class="detail-highlight">
            <div class="detail-summary-row">
              <div>
                <div class="canvas-label">STEPの役割</div>
                <h3>${escapeHtml(step.title)}</h3>
              </div>
              <span class="flow-mini-badge">${escapeHtml(step.short || '')}</span>
            </div>
            <p>${escapeHtml(step.objective || '')}</p>
            ${notice ? `<div class="character-inline-notice ${escapeHtml(notice.tone || 'info')}">${escapeHtml(notice.message || '')}</div>` : ''}
            <div class="story-meta-grid">
              <label class="preset-select-group">
                <span class="field-label">生成方式</span>
                <select id="sceneVideoWorkflowModeSelect" class="select-input compact-select">
                  <option value="auto" ${workflowMode === 'auto' ? 'selected' : ''}>自動</option>
                  <option value="i2v" ${workflowMode === 'i2v' ? 'selected' : ''}>I2V</option>
                  <option value="flf" ${workflowMode === 'flf' ? 'selected' : ''}>FLF</option>
                  <option value="ltx" ${workflowMode === 'ltx' ? 'selected' : ''}>LTX I2V</option>
                  <option value="ltx_flf" ${workflowMode === 'ltx_flf' ? 'selected' : ''}>LTX FLF</option>
                </select>
              </label>
              <label class="preset-select-group">
                <span class="field-label">FPS</span>
                <input id="sceneVideoFpsInput" class="text-input" type="number" min="8" max="32" step="1" value="${escapeHtml(sceneVideoState.fps || getDefaultSceneVideoFps(workflowMode))}" />
              </label>
              <label class="preset-select-group">
                <span class="field-label">最終作成日時</span>
                <input class="text-input" type="text" value="${escapeHtml(lastGeneratedText)}" disabled />
              </label>
            </div>
            <ul class="detail-list">
              <li><strong>制作フロープラン</strong>${escapeHtml(pipeline?.label || '未選択')}</li>
              <li><strong>既定の生成方式</strong>${escapeHtml(getSceneVideoWorkflowLabel(getDefaultSceneVideoWorkflowMode(), { isDefault: true }))}</li>
              <li><strong>シーン画像参照</strong>${escapeHtml(items.filter((item) => item?.image?.filename).length ? `${items.filter((item) => item?.image?.filename).length}シーン分` : '未準備')}</li>
              <li><strong>音楽同期メモ</strong>${escapeHtml(state.musicStep.generatedAudio?.filename || state.musicStep.lyricsText ? 'あり' : '未準備')}</li>
            </ul>
            <div class="character-ref-options">
              <label class="character-inline-option">
                <input id="sceneVideoUseScenePrompt" type="checkbox" ${sceneVideoState.useScenePrompt ? 'checked' : ''} ${state.sceneImageStep.scenePrompts.length ? '' : 'disabled'} />
                <span>シーン画像プロンプトを参照</span>
              </label>
              <label class="character-inline-option">
                <input id="sceneVideoUseMusicContext" type="checkbox" ${sceneVideoState.useMusicContext ? 'checked' : ''} ${state.musicStep.arrangementNotes || state.musicStep.lyricsText ? '' : 'disabled'} />
                <span>歌詞・音楽メモを参照</span>
              </label>
              ${isLtxWorkflow ? `
                <label class="character-inline-option">
                  <input id="sceneVideoAudioOff" type="checkbox" ${sceneVideoState.audioOff ? 'checked' : ''} />
                  <span>LTX オーディオOFF</span>
                </label>
              ` : ''}
            </div>
          </section>

          <section class="detail-block">
            <h3>シーン一覧</h3>
            <div class="scene-prompt-chip-grid">${sceneTabs}</div>
          </section>
        </div>

        <div class="detail-grid">
          <section class="detail-block">
            <h3>${escapeHtml(selected ? `Scene ${selected.sceneIndex} 動画プロンプト` : '動画プロンプト')}</h3>
            <p class="field-help">シーン画像を動かすためのプロンプトです。静止画の内容を保ちながら、穏やかな動きやカメラ演出を追記します。</p>
            <textarea id="sceneVideoPromptText" class="prompt-textarea scene-prompt-textarea" rows="10" placeholder="シーン画像生成後、ここで動画用の動き指示を調整します。">${escapeHtml(selected?.prompt || '')}</textarea>
            <div class="character-ref-options">
              <button id="sceneVideoPromptTranslateBtn" class="detail-action-btn secondary compact" type="button">🌐 翻訳</button>
            </div>
            <div class="scene-prompt-meta-grid">
              <label class="scene-prompt-meta-card scene-prompt-meta-card-editable">
                <strong>シーン尺（秒）</strong>
                <input id="sceneVideoDurationInput" class="text-input scene-meta-input" type="number" min="1" max="15" step="1" value="${escapeHtml(selected?.durationSec || 5)}" />
              </label>
              <div class="scene-prompt-meta-card"><strong>歌詞フック</strong><span>${escapeHtml(selected?.lyricExcerpt || '未割当')}</span></div>
              <label class="scene-prompt-meta-card scene-prompt-meta-card-editable">
                <strong>前シーンからの遷移</strong>
                <select id="sceneVideoTransitionSelect" class="select-input compact-select scene-meta-select" ${selectedIndex === 0 ? 'disabled' : ''}>
                  <option value="none" ${normalizeSceneTransitionType(selected?.transitionType, { sceneIndex: selectedIndex + 1 }) === 'none' ? 'selected' : ''}>なし</option>
                  <option value="cut" ${normalizeSceneTransitionType(selected?.transitionType, { sceneIndex: selectedIndex + 1 }) === 'cut' ? 'selected' : ''}>カット</option>
                  <option value="crossfade" ${normalizeSceneTransitionType(selected?.transitionType, { sceneIndex: selectedIndex + 1 }) === 'crossfade' ? 'selected' : ''}>クロスフェード</option>
                  <option value="fade_black" ${normalizeSceneTransitionType(selected?.transitionType, { sceneIndex: selectedIndex + 1 }) === 'fade_black' ? 'selected' : ''}>暗転</option>
                  <option value="flf" ${normalizeSceneTransitionType(selected?.transitionType, { sceneIndex: selectedIndex + 1 }) === 'flf' ? 'selected' : ''}>FLF補間</option>
                </select>
              </label>
            </div>
            <p class="field-help">${escapeHtml(getSceneTransitionDescription(selected?.transitionType, { sceneIndex: selectedIndex + 1, pipelinePresetId: String(state.selectedPipelinePresetId || ''), workflowMode }))}</p>
            <p class="field-help">${escapeHtml(selected?.transitionReason || '遷移理由は自動提案後に表示されます。')}</p>
            <p class="field-help">${escapeHtml(getPipelineTransitionGuidance(String(state.selectedPipelinePresetId || ''), workflowMode))}</p>
          </section>

          <section class="detail-block" data-scene-video-preview-block>
            <h3>${escapeHtml(selected ? `Scene ${selected.sceneIndex} プレビュー` : '動画プレビュー')}</h3>
            <p class="field-help">FLF / LTX FLF を選ぶと、次シーン画像がある場合は開始フレーム / 終了フレームとして補間します。なければ I2V 系に自動で戻ります。</p>
            <div class="character-ref-options">
              <button id="sceneVideoGenerateAllBtn" class="detail-action-btn secondary" type="button" ${sceneVideoGenerationBusy ? 'disabled' : ''}>${sceneVideoGenerationBusy ? '⏳ 動画生成中...' : '🎬 全てのシーン動画を生成'}</button>
              <button id="sceneVideoGenerateBtn" class="detail-action-btn primary" type="button" ${sceneVideoGenerationBusy ? 'disabled' : ''}>${sceneVideoGenerationBusy ? '⏳ 動画生成中...' : '🎬 このシーン動画を生成'}</button>
              ${sceneVideoGenerationBusy ? '<button id="sceneVideoCancelBtn" class="detail-action-btn secondary" type="button">⏹️ 中止</button>' : ''}
              ${selected?.video?.previewUrl ? '<button id="sceneVideoClearBtn" class="detail-action-btn secondary" type="button">クリア</button>' : ''}
            </div>
            <div class="scene-video-preview-grid">
              <div class="character-output-card">
                ${selected?.image?.previewUrl ? `
                  <button class="character-output-preview-btn" type="button" data-preview-image="${escapeHtml(selected.image.previewUrl)}" data-preview-title="${escapeHtml(selected.image.filename || `scene-${selected.sceneIndex}.png`)}" aria-label="シーン画像を拡大表示">
                    <img src="${escapeHtml(selected.image.previewUrl)}" alt="scene ${escapeHtml(selected.sceneIndex)} source" />
                  </button>
                  <div class="character-output-meta">開始画像: ${escapeHtml(selected.image.filename || `scene-${selected.sceneIndex}.png`)}</div>
                ` : '<div class="character-output-placeholder">シーン画像が未生成です</div>'}
              </div>
              <div class="character-output-card">
                ${selected?.video?.previewUrl ? `
                  <video controls playsinline preload="metadata" class="scene-video-player" src="${escapeHtml(selected.video.previewUrl)}"></video>
                  <div class="character-output-meta">${escapeHtml(selected.video.filename || `scene-${selected.sceneIndex}.mp4`)}</div>
                ` : '<div class="character-output-placeholder">まだこのシーン動画は生成されていません</div>'}
              </div>
            </div>
          </section>

          <section class="detail-block">
            <h3>次STEPへの受け渡し</h3>
            <ul class="detail-list">
              <li><strong>完成MVへ</strong>${escapeHtml(selected?.video?.filename ? '生成済みクリップを結合候補として渡す' : 'まず各シーンクリップを生成')}</li>
              <li><strong>開始画像</strong>${escapeHtml(selected?.image?.filename || '未準備')}</li>
              <li><strong>生成方式</strong>${escapeHtml(getSceneVideoWorkflowLabel(workflowMode))}</li>
              ${isLtxWorkflow ? `<li><strong>LTX音声</strong>${escapeHtml(sceneVideoState.audioOff ? 'OFF' : 'ON')}</li>` : ''}
              <li><strong>音声同期基準</strong>${escapeHtml(state.musicStep.generatedAudio?.filename || `${getEffectiveMusicDurationSec()}秒 / BPM ${state.musicStep.bpm || '未設定'}`)}</li>
            </ul>
          </section>

          <section class="mode-note">
            <strong>${escapeHtml(mode?.label || '自動制作')}時の見せ方</strong>
            <p>${escapeHtml(getModeSpecificHint(state.mode, step))}</p>
          </section>
        </div>
      </div>
    `;
  }

  function renderFinalMvWorkspace(step, mode) {
    const finalState = getFinalMvStepState();
    const preset = getPresetById();
    const pipeline = getSelectedPipelineOption(preset);
    const clipItems = getSceneVideoDisplayItems().filter((item) => item?.video?.filename);
    const audio = state.musicStep.generatedAudio;
    const notice = finalState.notice;
    const lastRenderedText = finalState.lastRenderedAt ? formatDateTime(finalState.lastRenderedAt) : '未生成';
    const sourceClipList = clipItems.map((item) => `<li>Scene ${escapeHtml(item.sceneIndex)} / ${escapeHtml(item.video?.filename || '')}</li>`).join('');

    return `
      <div class="detail-layout">
        <div class="detail-grid">
          <section class="detail-highlight">
            <div class="detail-summary-row">
              <div>
                <div class="canvas-label">STEPの役割</div>
                <h3>${escapeHtml(step.title)}</h3>
              </div>
              <span class="flow-mini-badge">${escapeHtml(step.short || '')}</span>
            </div>
            <p>${escapeHtml(step.objective || '')}</p>
            ${notice ? `<div class="character-inline-notice ${escapeHtml(notice.tone || 'info')}">${escapeHtml(notice.message || '')}</div>` : ''}
            <div class="story-meta-grid">
              <label class="preset-select-group">
                <span class="field-label">結合対象クリップ</span>
                <input class="text-input" type="text" value="${escapeHtml(`${clipItems.length}本`) }" disabled />
              </label>
              <label class="preset-select-group">
                <span class="field-label">使用音声</span>
                <input class="text-input" type="text" value="${escapeHtml(audio?.filename || '未生成')}" disabled />
              </label>
              <label class="preset-select-group">
                <span class="field-label">最終更新</span>
                <input class="text-input" type="text" value="${escapeHtml(lastRenderedText)}" disabled />
              </label>
            </div>
            <ul class="detail-list">
              <li><strong>制作フロープラン</strong>${escapeHtml(pipeline?.label || '未選択')}</li>
              <li><strong>シーン動画</strong>${escapeHtml(clipItems.length ? '結合可能' : '未準備')}</li>
              <li><strong>音楽素材</strong>${escapeHtml(audio?.filename || '未準備')}</li>
              <li><strong>出力対象</strong>${escapeHtml(finalState.finalVideo?.filename || finalState.clipVideo?.filename || '未生成')}</li>
            </ul>
          </section>

          <section class="detail-block">
            <h3>完成MV書き出し</h3>
            <p class="field-help">まずシーン動画を結合し、必要なら生成済み音声を合成して完成MVを出力します。</p>
            <div class="final-mv-action-stack">
              <div class="final-mv-action-row final-mv-action-row-single">
                <button id="finalMvAutoBtn" class="detail-action-btn primary" type="button" ${finalMvRenderBusy ? 'disabled' : ''}>${finalMvRenderBusy ? '⏳ 自動制作中...' : '✨ 自動制作（結合→完成MV）'}</button>
              </div>
              <div class="final-mv-action-row final-mv-action-row-pair">
                <button id="finalMvConcatBtn" class="detail-action-btn secondary" type="button" ${finalMvRenderBusy ? 'disabled' : ''}>${finalMvRenderBusy ? '⏳ 処理中...' : '🎞️ シーンクリップを結合'}</button>
                <span class="final-mv-action-arrow">→</span>
                <button id="finalMvRenderBtn" class="detail-action-btn primary" type="button" ${finalMvRenderBusy ? 'disabled' : ''}>${finalMvRenderBusy ? '⏳ 処理中...' : '🎵 音楽を合成して完成MV生成'}</button>
              </div>
              <div class="final-mv-action-row final-mv-action-row-single">
                ${(finalState.clipVideo?.previewUrl || finalState.finalVideo?.previewUrl) ? '<button id="finalMvClearBtn" class="detail-action-btn secondary" type="button">クリア</button>' : ''}
              </div>
            </div>
          </section>

          <section class="detail-block">
            <h3>結合元シーンクリップ</h3>
            ${sourceClipList ? `<ul class="detail-list">${sourceClipList}</ul>` : '<p class="field-help">先にシーン動画作成 STEP で各クリップを生成してください。</p>'}
          </section>
        </div>

        <div class="detail-grid">
          <section class="detail-block">
            <h3>中間クリップ結合結果</h3>
            <p class="field-help">音声なしで先に映像だけつないだ確認用クリップです。</p>
            <div class="character-output-card final-mv-output-card">
              ${finalState.clipVideo?.previewUrl ? `
                <video controls playsinline preload="metadata" class="scene-video-player final-mv-player" src="${escapeHtml(finalState.clipVideo.previewUrl)}"></video>
                <div class="character-output-meta">${escapeHtml(finalState.clipVideo.filename || 'concat.mp4')}</div>
              ` : '<div class="character-output-placeholder">まだ中間クリップは生成されていません</div>'}
            </div>
          </section>

          <section class="detail-block">
            <h3>完成MVプレビュー</h3>
            <p class="field-help">生成済み音楽を合成した最終確認用MVです。</p>
            <div class="character-output-card final-mv-output-card">
              ${finalState.finalVideo?.previewUrl ? `
                <video controls playsinline preload="metadata" class="scene-video-player final-mv-player" src="${escapeHtml(finalState.finalVideo.previewUrl)}"></video>
                <div class="character-output-meta">${escapeHtml(finalState.finalVideo.filename || 'final_mv.mp4')}</div>
              ` : '<div class="character-output-placeholder">まだ完成MVは生成されていません</div>'}
            </div>
          </section>

          <section class="detail-block">
            <h3>仕上げメモ</h3>
            <ul class="detail-list">
              <li><strong>映像結合</strong>${escapeHtml(finalState.clipVideo?.filename || '未生成')}</li>
              <li><strong>音楽合成</strong>${escapeHtml(finalState.finalVideo?.filename ? '完了' : '未実行')}</li>
              <li><strong>使用音声</strong>${escapeHtml(audio?.filename || '未生成')}</li>
              <li><strong>再編集導線</strong>${escapeHtml('必要なら scene_video / scene_image / music STEP へ戻って差し替えできます。')}</li>
            </ul>
          </section>

          <section class="mode-note">
            <strong>${escapeHtml(mode?.label || '自動制作')}時の見せ方</strong>
            <p>${escapeHtml(getModeSpecificHint(state.mode, step))}</p>
          </section>
        </div>
      </div>
    `;
  }

  function renderCharacterWorkspace(step, mode) {
    const characterState = getCharacterStepState();
    const slots = characterState.dropSlots || [null, null, null];
    const characters = characterState.characters || [];
    const selectedToken = String(characterState.selectedCharacterToken || '');
    const notice = characterState.notice;
    const primaryRef = getPrimaryCharacterReference();
    const analysisTarget = getCharacterAnalysisTarget();

    const slotsMarkup = slots.map((slot, index) => `
      <article class="character-slot-card ${slot ? 'filled' : ''}" data-slot-card="${index}">
        <div class="character-slot-top">
          <span class="flow-mini-badge">ref${index + 1}</span>
          ${slot ? `<button class="detail-action-btn secondary compact" type="button" data-slot-clear="${index}">削除</button>` : ''}
        </div>
        <div class="character-slot-preview">
          ${slot?.previewUrl ? `<img src="${escapeHtml(slot.previewUrl)}" alt="ref${index + 1}" />` : '<div class="character-slot-placeholder">参照画像を追加</div>'}
        </div>
        <div class="character-slot-meta">${escapeHtml(slot?.originalName || `ref${index + 1} をアップロード`)}</div>
        <input class="character-slot-input" data-slot-input="${index}" type="file" accept="image/*" hidden />
        <button class="detail-action-btn secondary" type="button" data-slot-upload="${index}">${slot ? '差し替え' : 'アップロード'}</button>
      </article>
    `).join('');

    const charactersMarkup = characters.length ? characters.map((item) => {
      const active = String(item.token || '') === selectedToken;
      const name = String(item.name || '').trim();
      return `
        <article class="character-registry-card ${active ? 'active' : ''}">
          <button class="character-registry-select character-registry-preview" type="button" data-character-token="${escapeHtml(item.token || '')}">
            ${item.preview_url ? `<img src="${escapeHtml(item.preview_url)}" alt="${escapeHtml(name)}" />` : '<div class="character-slot-placeholder">画像なし</div>'}
          </button>
          <button class="detail-action-btn secondary compact character-delete-btn" type="button" data-character-delete="${escapeHtml(name)}" aria-label="${escapeHtml(name)} を削除">削除</button>
          <button class="character-registry-select character-registry-meta" type="button" data-character-token="${escapeHtml(item.token || '')}">
            <strong>${escapeHtml(name)}</strong>
            <span>${escapeHtml(item.token || '')}</span>
          </button>
        </article>
      `;
    }).join('') : '<p class="field-help">登録済みキャラクタはまだありません。</p>';

    return `
      <div class="detail-layout character-step-layout">
        <div class="detail-grid">
          <section class="detail-highlight">
            <div class="detail-summary-row">
              <div>
                <div class="canvas-label">STEPの役割</div>
                <h3>${escapeHtml(step.title)}</h3>
              </div>
              <span class="flow-mini-badge">${escapeHtml(step.short || '')}</span>
            </div>
            <p>${escapeHtml(step.objective || '')}</p>
            ${notice ? `<div class="character-inline-notice ${escapeHtml(notice.tone || 'info')}">${escapeHtml(notice.message || '')}</div>` : ''}
            <div class="character-ref-grid">${slotsMarkup}</div>
            <div class="character-ref-options">
              <label class="character-inline-option">
                <input id="characterRef3ModeEnabled" type="checkbox" ${characterState.ref3ModeEnabled ? 'checked' : ''} />
                <span>ref3 を後続 I2I に活用</span>
              </label>
              <select id="characterRef3ModeSelect" class="select-input compact-select">
                <option value="background" ${characterState.ref3UseMode === 'background' ? 'selected' : ''}>背景として</option>
                <option value="style" ${characterState.ref3UseMode === 'style' ? 'selected' : ''}>画風として</option>
                <option value="anime" ${characterState.ref3UseMode === 'anime' ? 'selected' : ''}>アニメ風に</option>
              </select>
            </div>
          </section>

          <section class="detail-block">
            <h3>キャラ合成プロンプト</h3>
            <textarea id="characterPromptInput" class="prompt-textarea" rows="3" placeholder="例: @character_name, same outfit, front view, ref1 を基準に自然光で...">${escapeHtml(characterState.imagePrompt || '')}</textarea>
            <div class="character-ref-options">
              <button id="characterPromptTranslateBtn" class="detail-action-btn secondary compact" type="button" title="プロンプトを翻訳（英⇔日）">🌐 翻訳</button>
              <button id="characterImageGenerateBtn" class="detail-action-btn primary" type="button" ${characterImageGenerationBusy ? 'disabled' : ''}>${characterImageGenerationBusy ? '⏳ 生成中...' : 'キャラ合成画像を作成'}</button>
              ${characterState.characterImage ? `<button id="characterImageClearBtn" class="detail-action-btn secondary" type="button" ${characterImageGenerationBusy ? 'disabled' : ''}>クリア</button>` : ''}
            </div>
          </section>

          <section class="detail-block">
            <h3>キャラクタシート作成</h3>
            <p class="field-help">ref1 を起点に、ポーズ・見た目の確認用シートを作る想定です。</p>
            <div class="character-ref-options">
              <label class="character-inline-option">
                <input id="characterSheetNobg" type="checkbox" ${characterState.charSheetNobg ? 'checked' : ''} />
                <span>背景なし</span>
              </label>
              <button id="characterSheetGenerateBtn" class="detail-action-btn character-sheet-btn" type="button">キャラシートを作成</button>
              ${characterState.characterSheetImage ? '<button id="characterSheetClearBtn" class="detail-action-btn secondary" type="button">クリア</button>' : ''}
            </div>
            <div class="character-output-card">
              ${characterState.characterSheetImage?.previewUrl ? `
                <button class="character-output-preview-btn" type="button" data-preview-image="${escapeHtml(characterState.characterSheetImage.previewUrl)}" data-preview-title="${escapeHtml(characterState.characterSheetImage.filename || 'キャラシート')}" aria-label="キャラシートを拡大表示">
                  <img src="${escapeHtml(characterState.characterSheetImage.previewUrl)}" alt="character sheet" />
                </button>
                <div class="character-output-meta">${escapeHtml(characterState.characterSheetImage.filename || 'キャラシート')}</div>
              ` : '<div class="character-output-placeholder">キャラシートはまだ作成されていません</div>'}
            </div>
          </section>

          <section class="detail-block">
            <h3>キャラクタ一覧 / 登録</h3>
            <div class="character-register-row">
              <input id="characterRegisterName" class="text-input compact-input" type="text" placeholder="例: character_name" maxlength="40" />
              <input id="characterRegisterFile" class="text-input compact-input" type="file" accept="image/*" />
              <button id="characterRegisterBtn" class="detail-action-btn secondary" type="button">登録</button>
              <button id="characterRefreshBtn" class="detail-action-btn secondary" type="button">更新</button>
            </div>
            <div class="character-registry-grid">${charactersMarkup}</div>
          </section>
        </div>

        <div class="detail-grid">
          <section class="detail-block">
            <h3>キャラ合成画像</h3>
            <p class="field-help">キャラ合成プロンプトと ref1/ref2/ref3 を使って、後続STEPの基準になる1枚を生成します。</p>
            <div class="character-output-card">
              ${characterState.characterImage?.previewUrl ? `
                <button class="character-output-preview-btn" type="button" data-preview-image="${escapeHtml(characterState.characterImage.previewUrl)}" data-preview-title="${escapeHtml(characterState.characterImage.filename || 'キャラ合成画像')}" aria-label="キャラ合成画像を拡大表示">
                  <img src="${escapeHtml(characterState.characterImage.previewUrl)}" alt="character composite" />
                </button>
                <div class="character-output-meta">${escapeHtml(characterState.characterImage.filename || 'キャラ合成画像')}</div>
                <div class="character-ref-options">
                  <button id="characterImageFitVideoBtn" class="detail-action-btn secondary compact" type="button" ${characterImageGenerationBusy ? 'disabled' : ''}>動画比率に整える</button>
                  <span class="field-help">1280×720 に上下を切らず、ぼかし余白で調整します。</span>
                </div>
              ` : '<div class="character-output-placeholder">キャラ合成画像はまだ作成されていません</div>'}
            </div>
          </section>

          <section class="detail-block">
            <h3>VLM / VLLM 画像解析</h3>
            <p class="field-help">キャラシート → キャラ合成画像 → ref1 の優先順で解析し、キャラ設計や後続プロンプトの基準文を作ります。</p>
            <div class="detail-actions">
              <button class="detail-action-btn primary" id="characterAnalyzeBtn" type="button" ${analysisTarget ? '' : 'disabled'}>画像を解析</button>
              <button class="detail-action-btn secondary compact" id="characterAnalysisTranslateBtn" type="button" title="解析結果を翻訳（英⇔日）">🌐 翻訳</button>
            </div>
            <textarea id="characterAnalysisText" class="prompt-textarea" rows="6" placeholder="解析結果はここに表示されます">${escapeHtml(characterState.keyImageAnalysis || '')}</textarea>
          </section>

          <section class="detail-block">
            <h3>生成結果の受け渡し</h3>
            <ul class="detail-list">
              <li><strong>選択中キャラクタ</strong>${escapeHtml(selectedToken || '未選択')}</li>
              <li><strong>解析基準画像</strong>${escapeHtml(analysisTarget?.originalName || '未設定')}</li>
              <li><strong>キャラ合成画像</strong>${escapeHtml(characterState.characterImage?.filename || '次段で生成接続')}</li>
              <li><strong>キャラシート</strong>${escapeHtml(characterState.characterSheetImage?.filename || '次段で生成接続')}</li>
            </ul>
          </section>

          <section class="mode-note">
            <strong>${escapeHtml(mode?.label || '自動制作')}時の見せ方</strong>
            <p>${escapeHtml(getModeSpecificHint(state.mode, step))}</p>
          </section>
        </div>
      </div>
    `;
  }

  function renderDetail() {
    const preset = getPresetById();
    const step = getCurrentStep();
    const mode = getModeMeta();

    if (!preset || !step) {
      els.detailTitle.textContent = 'STEPを選択してください';
      els.detailSubtitle.textContent = '上部フローからクリックすると、サブフローや設定を表示します。';
      els.detailSubtitle.hidden = false;
      renderDetailStepSummary(null);
      if (els.detailModeBadge) {
        els.detailModeBadge.textContent = '未選択';
      }
      els.detailBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎬</div>
          <h3>まずはプリセットを選択</h3>
          <p>フローの全体像と、選択STEPに対応する大きな作業領域をここに表示します。</p>
        </div>
      `;
      return;
    }

    els.detailTitle.textContent = `${step.title} エリア`;
    els.detailSubtitle.textContent = '';
    els.detailSubtitle.hidden = true;
    renderDetailStepSummary(step);
    if (els.detailModeBadge) {
      els.detailModeBadge.textContent = mode?.label || '未選択';
    }

    if (String(step.id) === 'character') {
      els.detailBody.innerHTML = renderCharacterWorkspace(step, mode);
      return;
    }

    if (String(step.id) === 'story') {
      els.detailBody.innerHTML = renderStoryWorkspace(step, mode);
      return;
    }

    if (String(step.id) === 'music') {
      els.detailBody.innerHTML = renderMusicWorkspace(step, mode);
      bindMusicAudioWaveformEvents();
      ensureMusicWaveformPreview();
      return;
    }

    if (String(step.id) === 'scene_image') {
      els.detailBody.innerHTML = renderSceneImageWorkspace(step, mode);
      return;
    }

    if (String(step.id) === 'scene_video') {
      els.detailBody.innerHTML = renderSceneVideoWorkspace(step, mode);
      return;
    }

    if (String(step.id) === 'final_mv') {
      els.detailBody.innerHTML = renderFinalMvWorkspace(step, mode);
      syncFinalMvActionButtonWidths();
      return;
    }

    const subflows = (step.subflows || []).map((item) => `
      <article class="subflow-card">
        <h4>${escapeHtml(item)}</h4>
        <p>${escapeHtml(step.title)} の中で個別に開けるサブフロー候補です。設定パネルやジョブ起動UIをここに配置する想定です。</p>
      </article>
    `).join('');

    const settingsList = (step.settings || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    const outputsList = (step.outputs || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    const summaryPoints = (step.summary_points || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('');

    els.detailBody.innerHTML = `
      <div class="detail-layout">
        <div class="detail-grid">
          <section class="detail-highlight">
            <div class="detail-summary-row">
              <div>
                <div class="canvas-label">STEPの役割</div>
                <h3>${escapeHtml(step.title)}</h3>
              </div>
              <span class="flow-mini-badge">${escapeHtml(step.short || '')}</span>
            </div>
            <p>${escapeHtml(step.objective || '')}</p>
            <ul class="detail-list">
              ${summaryPoints}
            </ul>
          </section>

          <section class="detail-block">
            <h3>サブフロー候補</h3>
            <p>クリックしたSTEPの中で、さらに分岐する操作群をこのエリアに大きく表示する想定です。</p>
            <div class="subflow-grid">${subflows}</div>
          </section>

          <section class="mode-note">
            <strong>${escapeHtml(mode?.label || '自動制作')}時の見せ方</strong>
            <p>${escapeHtml(getModeSpecificHint(state.mode, step))}</p>
            <div class="detail-actions">
              <button class="detail-action-btn primary" type="button">このSTEPから開始</button>
              <button class="detail-action-btn secondary" type="button">前後STEPの依存関係を確認</button>
              <button class="detail-action-btn secondary" type="button">完成MVまでの到達イメージを見る</button>
            </div>
          </section>
        </div>

        <div class="detail-grid">
          <section class="detail-block">
            <h3>主な設定</h3>
            <p class="field-help">ここにはフォーム、ワークフロー選択、モデル設定、ジョブオプションが入る想定です。</p>
            <ul class="detail-list">${settingsList}</ul>
          </section>

          <section class="detail-block">
            <h3>このSTEPの出力</h3>
            <ul class="detail-list">${outputsList}</ul>
          </section>

          <section class="detail-block">
            <h3>次STEPへの受け渡し</h3>
            <p>${escapeHtml(step.handoff || '')}</p>
          </section>

          <section class="detail-block">
            <h3>制作キャンバス反映メモ</h3>
            <ul class="detail-list">
              <li><strong>選択中キャンバス</strong>${escapeHtml(state.canvas.name || '新しいキャンバス')}</li>
              <li><strong>選択中プリセット</strong>${escapeHtml(preset.name)}</li>
              <li><strong>到達STEP</strong>${escapeHtml(step.title)}</li>
            </ul>
          </section>
        </div>
      </div>
    `;
  }

  function syncFinalMvActionButtonWidths() {
    const stack = els.detailBody?.querySelector('.final-mv-action-stack');
    const autoBtn = stack?.querySelector('#finalMvAutoBtn');
    if (!stack || !autoBtn) {
      return;
    }

    stack.style.removeProperty('--final-mv-base-btn-width');
    window.requestAnimationFrame(() => {
      const width = Math.ceil(autoBtn.getBoundingClientRect().width || 0);
      if (width > 0) {
        stack.style.setProperty('--final-mv-base-btn-width', `${width}px`);
      }
    });
  }

  function renderAll() {
    renderPresetOptions();
    renderCanvasSummary();
    renderPresetOverview();
    renderFlowPreview();
    renderDetail();
  }

  function selectPreset(presetId, { keepStep = false } = {}) {
    state.selectedPresetId = String(presetId || '');
    const preset = getPresetById();
    if (!keepStep || !preset?.steps?.some((step) => String(step.id) === String(state.selectedStepId))) {
      state.selectedStepId = defaultStepIdForPreset(preset);
    }
    if (!state.canvas.name || state.canvas.name.startsWith('新規キャンバス')) {
      state.canvas.name = createCanvasName(preset?.name || '新規キャンバス');
    }
    if (!state.mode || !getModeMeta(state.mode)) {
      state.mode = String(preset?.recommended_mode || 'new');
    }
    const pipelineExists = getPipelineOptionsForPreset(preset).some((item) => String(item.id) === String(state.selectedPipelinePresetId));
    if (!pipelineExists) {
      state.selectedPipelinePresetId = defaultPipelinePresetIdForPreset(preset);
    }
    state.canvas.updatedAt = Date.now();
    renderAll();
    scheduleSave();
  }

  function selectPipelinePreset(pipelinePresetId) {
    state.selectedPipelinePresetId = String(pipelinePresetId || '');
    state.canvas.updatedAt = Date.now();
    renderAll();
    scheduleSave();
  }

  function selectMode(modeId) {
    state.mode = String(modeId || 'new');
    state.canvas.updatedAt = Date.now();
    renderAll();
    scheduleSave();
  }

  function selectStep(stepId) {
    state.selectedStepId = String(stepId || '');
    state.canvas.updatedAt = Date.now();
    renderAll();
    scheduleSave();
  }

  function createNewCanvas() {
    const preset = getPresetById();
    state.canvas = {
      id: crypto?.randomUUID?.() || `canvas-${Date.now()}`,
      name: createCanvasName(preset?.name || '新規キャンバス'),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    state.mode = String(preset?.recommended_mode || 'new');
    state.selectedStepId = defaultStepIdForPreset(preset);
    renderAll();
    scheduleSave();
  }

  async function uploadCharacterRefSlot(slotIndex, file) {
    if (!(file instanceof File)) return;
    if (!String(file.type || '').startsWith('image/')) {
      throw new Error('画像ファイルを選択してください');
    }
    const formData = new FormData();
    formData.append('client_session_id', getSessionId());
    formData.append('file', file);
    const response = await fetch('/api/v1/production/upload-ref-slot', {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.characterStep.dropSlots[slotIndex] = {
      filename: data.filename,
      originalName: data.original_filename || data.filename,
      previewUrl: data.preview_url,
    };
    state.characterStep.characterImage = null;
    if (slotIndex === 0) {
      state.characterStep.characterSheetImage = null;
    }
    setCharacterNotice(`ref${slotIndex + 1} を更新しました`, 'success');
    state.canvas.updatedAt = Date.now();
    renderDetail();
    scheduleSave();
  }

  async function registerCharacterFromForm(name, file) {
    const formData = new FormData();
    formData.append('name', name);
    formData.append('client_session_id', getSessionId());
    formData.append('file', file);
    const response = await fetch('/api/v1/production/ref-images', {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    state.characterStep.selectedCharacterToken = `@${name.replace(/^@+/, '')}`;
    if (!state.characterStep.imagePrompt.includes(state.characterStep.selectedCharacterToken)) {
      state.characterStep.imagePrompt = `${state.characterStep.imagePrompt ? `${state.characterStep.imagePrompt}\n` : ''}${state.characterStep.selectedCharacterToken}`;
    }
    setCharacterNotice(`キャラクタ「${name}」を登録しました`, 'success');
    state.canvas.updatedAt = Date.now();
    await refreshCharacterRegistry({ rerender: false });
    renderDetail();
    scheduleSave();
  }

  async function deleteRegisteredCharacter(name) {
    const normalizedName = String(name || '').trim().replace(/^@+/, '');
    if (!normalizedName) return;
    const ok = window.confirm(`登録キャラクタ「${normalizedName}」を削除しますか？\nこの操作は一覧登録と登録画像ファイルを削除します。`);
    if (!ok) return;

    const response = await fetch(`/api/v1/production/ref-images/${encodeURIComponent(normalizedName)}?client_session_id=${encodeURIComponent(getSessionId())}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const payload = await response.text();
      throw new Error(`HTTP ${response.status}: ${payload}`);
    }

    const token = `@${normalizedName}`;
    if (state.characterStep.selectedCharacterToken === token) {
      state.characterStep.selectedCharacterToken = '';
    }
    state.characterStep.imagePrompt = String(state.characterStep.imagePrompt || '')
      .split('\n')
      .filter((line) => line.trim() !== token)
      .join('\n');
    setCharacterNotice(`キャラクタ「${normalizedName}」を削除しました`, 'success');
    state.canvas.updatedAt = Date.now();
    await refreshCharacterRegistry({ rerender: false });
    renderDetail();
    scheduleSave();
  }

  async function analyzeCharacterReference() {
    const analysisTarget = getCharacterAnalysisTarget();
    if (!analysisTarget?.previewUrl) {
      setCharacterNotice('先にキャラシート・キャラ合成画像・ref1 のいずれかを用意してください', 'warning');
      renderDetail();
      return;
    }

    debugLog('vlm-analyze request', {
      sessionId: getSessionId(),
      targetSource: analysisTarget.source,
      targetName: analysisTarget.originalName,
      targetPreviewUrl: analysisTarget.previewUrl,
    });

    setCharacterNotice(`${analysisTarget.originalName || '画像'} を解析中です...`, 'info');
    renderDetail();

    const imageResponse = await fetch(analysisTarget.previewUrl, { cache: 'no-store' });
    if (!imageResponse.ok) throw new Error(`画像取得エラー: ${imageResponse.status}`);
    const blob = await imageResponse.blob();
    const imageBase64 = await blobToBase64(blob);

    const response = await fetch('/api/v1/production/vlm/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image_base64: imageBase64,
        mode: 'image',
        language: 'ja',
        focus_area: 'character design, clothing, color palette, reusable prompt cues',
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    debugLog('vlm-analyze response', {
      targetSource: analysisTarget.source,
      targetName: analysisTarget.originalName,
      elapsedTime: result?.elapsed_time,
      descriptionLength: String(result?.description || '').length,
    });
    const parsed = parseVLMOutput(result.description || '');
    state.characterStep.keyImageAnalysis = parsed.prompt || result.description || '';
    state.characterStep.keyImageAnalysisRaw = result;
    setCharacterNotice('画像解析が完了しました', 'success');
    state.canvas.updatedAt = Date.now();
    renderDetail();
    scheduleSave();
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeCharacterToken(value) {
    return String(value || '')
      .replace(/^[@＠]+/, '')
      .trim()
      .toLowerCase();
  }

  function expandCharacterPromptForPreview(promptText, options = {}) {
    const prompt = String(promptText || '').trim();
    const characterState = getCharacterStepState();
    const characters = Array.isArray(characterState.characters) ? characterState.characters : [];
    const dropSlots = Array.isArray(characterState.dropSlots) ? characterState.dropSlots : [];
    const seedImageFilename = String(options.seedImageFilename || '').trim();

    const tokenMatches = [...prompt.matchAll(/[@＠]([^\s@＠,.<>「」"“”]+)/g)];
    const pictureMappings = [];
    const inputImages = [];
    const seenFiles = new Set();
    let nextPictureNum = 1;

    if (seedImageFilename) {
      seenFiles.add(seedImageFilename);
      inputImages.push(seedImageFilename);
      nextPictureNum += 1;
    }

    tokenMatches.forEach((match) => {
      const original = String(match[0] || '');
      const tokenName = normalizeCharacterToken(match[1] || '');
      if (!tokenName) return;
      const character = characters.find((item) => {
        const itemToken = normalizeCharacterToken(item?.token || item?.name || '');
        return itemToken === tokenName;
      });
      const filename = String(character?.filename || '').trim();
      if (!filename || seenFiles.has(filename)) return;
      seenFiles.add(filename);
      pictureMappings.push({ pattern: new RegExp(escapeRegExp(original), 'g'), replacement: `Picture ${nextPictureNum}` });
      inputImages.push(filename);
      nextPictureNum += 1;
    });

    ['ref1', 'ref2', 'ref3'].forEach((refName, index) => {
      const slot = dropSlots[index];
      const filename = String(slot?.filename || '').trim();
      if (!filename || seenFiles.has(filename)) return;
      seenFiles.add(filename);
      pictureMappings.push({ pattern: new RegExp(`\\b${refName}\\b`, 'gi'), replacement: `Picture ${nextPictureNum}` });
      inputImages.push(filename);
      nextPictureNum += 1;
    });

    let expandedPrompt = prompt;
    pictureMappings.forEach(({ pattern, replacement }) => {
      expandedPrompt = expandedPrompt.replace(pattern, replacement);
    });

    return {
      expandedPrompt,
      inputImages: inputImages.slice(0, 3),
    };
  }

  function applyCharacterCompositeReferenceHint(promptText, inputImages) {
    const prompt = String(promptText || '').trim();
    const imageCount = Array.isArray(inputImages) ? inputImages.filter(Boolean).length : 0;
    if (!prompt || imageCount < 2) {
      return prompt;
    }

    const guard = [
      'Reference priority:',
      'Picture 1 is the main character/subject. Keep the face, hair, outfit, body, and identity from Picture 1.',
      'If Picture 2 or Picture 3 are used, treat them as supporting references for stage, background, lighting, style, or pose unless the instruction clearly says otherwise.',
      'When the prompt asks for the character from Picture 1 to stand on the stage or background from Picture 2, keep the character from Picture 1 and use only the stage/background from Picture 2.',
      'Do not replace the main character with Picture 2 or Picture 3.',
    ].join(' ');

    if (/Reference priority:|Picture 1 is the main character\/subject\./i.test(prompt)) {
      return prompt;
    }
    return `${guard}\n${prompt}`;
  }

  function applyExistingCharacterImageHint(promptText, enabled) {
    const prompt = String(promptText || '').trim();
    if (!enabled || !prompt) return prompt;
    if (/current character composite image|previous result|keep the character identity.*picture 1/i.test(prompt)) {
      return prompt;
    }
    return [
      'Picture 1 is the current character composite image from the previous result.',
      'Keep the character identity, face, hair, outfit, and overall composition from Picture 1 unless the instruction clearly asks to change them.',
      prompt,
    ].join('\n');
  }

  function debugLog(label, payload) {
    try {
      console.log(`[production] ${label}`, payload);
    } catch (_error) {
      // noop
    }
  }

  async function generateCharacterImage() {
    if (characterImageGenerationBusy) {
      return;
    }

    const characterState = getCharacterStepState();
    const primaryRef = getPrimaryCharacterReference();
    const rawPrompt = String(characterState.imagePrompt || '').trim();
    let seedImageFilename = '';

    if (!rawPrompt) {
      setCharacterNotice('キャラ合成プロンプトを入力してください', 'warning');
      renderDetail();
      return;
    }

    if (characterState.characterImage?.filename) {
      const choice = await showCharacterImageReferenceDialog();
      if (choice === 'cancel') {
        return;
      }
      if (choice === 'clear') {
        state.characterStep.characterImage = null;
        setCharacterNotice('現在のキャラ合成画像をクリアして生成します', 'info');
        renderDetail();
      } else if (choice === 'reference') {
        seedImageFilename = String(characterState.characterImage.filename || '').trim();
      }
    }

    const { expandedPrompt, inputImages } = expandCharacterPromptForPreview(rawPrompt, { seedImageFilename });
    if (!inputImages.length) {
      setCharacterNotice('ref1/ref2/ref3 または @キャラ名 を含めてください', 'warning');
      renderDetail();
      return;
    }
    const finalPrompt = applyExistingCharacterImageHint(
      applyCharacterCompositeReferenceHint(expandedPrompt, inputImages),
      !!seedImageFilename,
    );
    if (!finalPrompt) {
      setCharacterNotice('キャラ合成プロンプトを入力してください', 'warning');
      renderDetail();
      return;
    }

    debugLog('character-image request', {
      sessionId: getSessionId(),
      primaryRef: primaryRef?.filename || null,
      inputImages,
      rawPrompt,
      expandedPrompt,
      finalPrompt,
      selectedCharacterToken: state.characterStep.selectedCharacterToken || null,
    });

    setCharacterNotice('キャラ合成画像を生成中です...', 'info');
    characterImageGenerationBusy = true;
    renderDetail();

    try {
      const response = await fetch('/api/v1/production/character-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          prompt: finalPrompt,
          input_images: inputImages,
          cfg: 1.0,
          denoise: 1.0,
        }),
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      if (!response.ok) {
        debugLog('character-image error response', { status: response.status, payload });
        throw new Error(payload?.detail || `HTTP ${response.status}`);
      }

      debugLog('character-image response', payload);

      state.characterStep.characterImage = {
        filename: payload.filename || 'character-image.png',
        previewUrl: payload.preview_url || '',
        subfolder: payload.subfolder || '',
        type: payload.type || 'output',
        workflow: payload.workflow || '',
        promptId: payload.prompt_id || '',
      };
      setCharacterNotice('キャラ合成画像を生成しました', 'success');
      state.canvas.updatedAt = Date.now();
      renderDetail();
      scheduleSave();
    } finally {
      characterImageGenerationBusy = false;
      renderDetail();
    }
  }

  async function fitCharacterImageForVideo() {
    if (characterImageGenerationBusy) {
      return;
    }
    const characterState = getCharacterStepState();
    const filename = String(characterState.characterImage?.filename || '').trim();
    if (!filename) {
      setCharacterNotice('先にキャラ合成画像を生成してください', 'warning');
      renderDetail();
      return;
    }

    characterImageGenerationBusy = true;
    setCharacterNotice('キャラ合成画像を動画比率に整えています...', 'info');
    renderDetail();

    try {
      const response = await fetch('/api/v1/production/character-image/fit-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_session_id: getSessionId(),
          filename,
          target_width: 1280,
          target_height: 720,
          mode: 'contain_blur',
        }),
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      if (!response.ok) {
        debugLog('character-image fit-video error response', { status: response.status, payload });
        throw new Error(payload?.detail || `HTTP ${response.status}`);
      }

      debugLog('character-image fit-video response', payload);
      state.characterStep.characterImage = {
        ...characterState.characterImage,
        filename: payload.filename || 'character-image-fit.png',
        previewUrl: payload.preview_url || '',
        subfolder: payload.subfolder || '',
        type: payload.type || 'output',
        workflow: payload.fit_mode || characterState.characterImage?.workflow || '',
        sourceFilename: payload.source_filename || filename,
      };
      setCharacterNotice('キャラ合成画像を動画比率に整えました', 'success');
      state.canvas.updatedAt = Date.now();
      renderDetail();
      scheduleSave();
    } finally {
      characterImageGenerationBusy = false;
      renderDetail();
    }
  }

  async function generateCharacterSheet() {
    const primaryRef = getPrimaryCharacterReference();
    if (!primaryRef?.filename) {
      setCharacterNotice('先に ref1 などへ参照画像を追加してください', 'warning');
      renderDetail();
      return;
    }

    setCharacterNotice('キャラシートを生成中です...', 'info');
    renderDetail();

    debugLog('character-sheet request', {
      sessionId: getSessionId(),
      sourceFilename: primaryRef.filename,
      nobg: !!state.characterStep.charSheetNobg,
    });

    const response = await fetch('/api/v1/production/character-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_session_id: getSessionId(),
        source_filename: primaryRef.filename,
        nobg: !!state.characterStep.charSheetNobg,
      }),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (_error) {
      payload = null;
    }

    if (!response.ok) {
      debugLog('character-sheet error response', { status: response.status, payload });
      throw new Error(payload?.detail || `HTTP ${response.status}`);
    }

    debugLog('character-sheet response', payload);

    state.characterStep.characterSheetImage = {
      filename: payload.filename || 'character-sheet.png',
      previewUrl: payload.preview_url || '',
      subfolder: payload.subfolder || '',
      type: payload.type || 'output',
      workflow: payload.workflow || '',
      promptId: payload.prompt_id || '',
    };
    setCharacterNotice('キャラシートを生成しました', 'success');
    state.canvas.updatedAt = Date.now();
    renderDetail();
    scheduleSave();
  }

  function openImagePreview(src, title) {
    if (!els.imagePreviewModal || !els.imagePreviewModalImage || !src) return;
    els.imagePreviewModalImage.src = src;
    els.imagePreviewModalImage.alt = title || '拡大画像';
    if (els.imagePreviewTitle) {
      els.imagePreviewTitle.textContent = title || '画像プレビュー';
    }
    if (els.imagePreviewCaption) {
      els.imagePreviewCaption.textContent = title || 'プレビュー画像';
    }
    els.imagePreviewModal.classList.remove('hidden');
    els.imagePreviewModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeImagePreview() {
    if (!els.imagePreviewModal || !els.imagePreviewModalImage) return;
    els.imagePreviewModal.classList.add('hidden');
    els.imagePreviewModal.setAttribute('aria-hidden', 'true');
    els.imagePreviewModalImage.src = '';
    document.body.style.overflow = '';
  }

  function bindEvents() {
    els.presetSelect.addEventListener('change', (event) => {
      selectPreset(event.target.value);
    });

    els.presetOverview.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode-id]');
      if (!button) return;
      selectMode(button.getAttribute('data-mode-id'));
    });

    els.presetOverview.addEventListener('change', (event) => {
      const select = event.target.closest('#pipelineSelect');
      if (!select) return;
      selectPipelinePreset(select.value);
    });

    els.flowPreview.addEventListener('click', (event) => {
      const button = event.target.closest('[data-step-id]');
      if (!button) return;
      selectStep(button.getAttribute('data-step-id'));
    });

    els.detailBody.addEventListener('click', async (event) => {
      const slotCard = event.target.closest('[data-slot-card]');
      if (slotCard && !event.target.closest('button')) {
        const index = Number(slotCard.getAttribute('data-slot-card'));
        const input = els.detailBody.querySelector(`[data-slot-input="${index}"]`);
        input?.click();
        return;
      }

      const uploadButton = event.target.closest('[data-slot-upload]');
      if (uploadButton) {
        const index = Number(uploadButton.getAttribute('data-slot-upload'));
        const input = els.detailBody.querySelector(`[data-slot-input="${index}"]`);
        input?.click();
        return;
      }

      const clearButton = event.target.closest('[data-slot-clear]');
      if (clearButton) {
        const index = Number(clearButton.getAttribute('data-slot-clear'));
        state.characterStep.dropSlots[index] = null;
        state.characterStep.characterImage = null;
        if (index === 0) {
          state.characterStep.characterSheetImage = null;
        }
        setCharacterNotice(`ref${index + 1} をクリアしました`, 'info');
        renderDetail();
        scheduleSave();
        return;
      }

      const characterDeleteButton = event.target.closest('[data-character-delete]');
      if (characterDeleteButton) {
        const name = String(characterDeleteButton.getAttribute('data-character-delete') || '');
        try {
          await deleteRegisteredCharacter(name);
        } catch (error) {
          setCharacterNotice(error.message || 'キャラクタ削除に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      const characterButton = event.target.closest('[data-character-token]');
      if (characterButton) {
        const token = String(characterButton.getAttribute('data-character-token') || '');
        state.characterStep.selectedCharacterToken = token;
        if (token && !state.characterStep.imagePrompt.includes(token)) {
          state.characterStep.imagePrompt = `${state.characterStep.imagePrompt ? `${state.characterStep.imagePrompt}\n` : ''}${token}`;
        }
        setCharacterNotice(`${token} を選択しました`, 'success');
        renderDetail();
        scheduleSave();
        return;
      }

      const previewButton = event.target.closest('[data-preview-image]');
      if (previewButton) {
        openImagePreview(
          String(previewButton.getAttribute('data-preview-image') || ''),
          String(previewButton.getAttribute('data-preview-title') || 'キャラシート'),
        );
        return;
      }

      if (event.target.closest('#characterRefreshBtn')) {
        await refreshCharacterRegistry();
        setCharacterNotice('キャラクタ一覧を更新しました', 'info');
        renderDetail();
        return;
      }

      if (event.target.closest('#characterRegisterBtn')) {
        const nameInput = els.detailBody.querySelector('#characterRegisterName');
        const fileInput = els.detailBody.querySelector('#characterRegisterFile');
        const name = String(nameInput?.value || '').trim();
        const file = fileInput?.files?.[0] || null;
        if (!name || !file) {
          setCharacterNotice('キャラクタ名と画像ファイルを指定してください', 'warning');
          renderDetail();
          return;
        }
        try {
          await registerCharacterFromForm(name, file);
        } catch (error) {
          setCharacterNotice(error.message || 'キャラクタ登録に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#characterAnalyzeBtn')) {
        try {
          await analyzeCharacterReference();
        } catch (error) {
          setCharacterNotice(error.message || '画像解析に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#characterPromptTranslateBtn')) {
        try {
          await translateCharacterPrompt();
        } catch (error) {
          setCharacterNotice(error.message || 'プロンプト翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#characterAnalysisTranslateBtn')) {
        try {
          await translateCharacterAnalysis();
        } catch (error) {
          setCharacterNotice(error.message || '解析結果翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#storyGenerateBtn')) {
        try {
          await generateStoryScenario();
        } catch (error) {
          setStoryNotice(error.message || 'シナリオ生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#storyUseCharacterContextBtn')) {
        applyCharacterContextToStoryNotes();
        return;
      }

      if (event.target.closest('#storyIdeaTranslateBtn')) {
        try {
          await translateStoryField('idea', '翻訳するざっくり意図がありません');
        } catch (error) {
          setStoryNotice(error.message || 'ざっくり意図の翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#storyWorldNotesTranslateBtn')) {
        try {
          await translateStoryField('worldNotes', '翻訳する世界観メモがありません');
        } catch (error) {
          setStoryNotice(error.message || '世界観メモの翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#storyScenarioTranslateBtn')) {
        try {
          await translateStoryField('scenarioText', '翻訳するシナリオがありません');
        } catch (error) {
          setStoryNotice(error.message || 'シナリオ翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#storyScenarioClearBtn')) {
        clearStoryScenario();
        return;
      }

      if (event.target.closest('#musicGenerateBtn')) {
        try {
          await generateMusicPlan();
        } catch (error) {
          setMusicNotice(error.message || '音楽プラン生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicProduceBtn')) {
        try {
          await produceMusicAudio();
        } catch (error) {
          setMusicNotice(error.message || '音楽生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicImportAudioBtn')) {
        els.detailBody.querySelector('#musicImportAudioInput')?.click();
        return;
      }

      if (event.target.closest('#musicAudioClearBtn')) {
        clearMusicAudio();
        return;
      }

      if (event.target.closest('#musicAudioTrimBtn')) {
        try {
          await trimMusicAudio();
        } catch (error) {
          setMusicNotice(error.message || '音声トリミングに失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicScenePlanSuggestBtn')) {
        try {
          await proposeScenePlanFromMusicStep();
        } catch (error) {
          setMusicNotice(error.message || 'シーン尺の再提案に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicUseStoryContextBtn')) {
        applyStoryContextToMusicPrompt();
        return;
      }

      if (event.target.closest('#musicPromptTranslateBtn')) {
        try {
          await translateMusicField('musicPrompt', '翻訳する曲の方向性メモがありません');
        } catch (error) {
          setMusicNotice(error.message || '曲の方向性メモの翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicLyricsTranslateBtn')) {
        try {
          await translateMusicField('lyricsText', '翻訳する歌詞がありません');
        } catch (error) {
          setMusicNotice(error.message || '歌詞翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicTagsTranslateBtn')) {
        try {
          await translateMusicField('tagsText', '翻訳する音楽タグがありません');
        } catch (error) {
          setMusicNotice(error.message || '音楽タグ翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicArrangementTranslateBtn')) {
        try {
          await translateMusicField('arrangementNotes', '翻訳するアレンジメモがありません');
        } catch (error) {
          setMusicNotice(error.message || 'アレンジメモ翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#musicPlanClearBtn')) {
        clearMusicPlan();
        return;
      }

      const sceneSelectButton = event.target.closest('[data-scene-select]');
      if (sceneSelectButton) {
        state.sceneImageStep.selectedSceneIndex = Math.max(0, Number(sceneSelectButton.getAttribute('data-scene-select')) || 0);
        renderDetail();
        scheduleSave();
        return;
      }

      const sceneVideoSelectButton = event.target.closest('[data-scene-video-select]');
      if (sceneVideoSelectButton) {
        state.sceneVideoStep.selectedSceneIndex = Math.max(0, Number(sceneVideoSelectButton.getAttribute('data-scene-video-select')) || 0);
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.closest('#scenePromptGenerateBtn')) {
        try {
          await generateScenePrompts();
        } catch (error) {
          setSceneImageNotice(error.message || 'シーンプロンプト生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#scenePlanSuggestBtn')) {
        try {
          await proposeScenePlan();
        } catch (error) {
          setSceneImageNotice(error.message || 'シーン尺・遷移提案に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#scenePromptTranslateBtn')) {
        try {
          await translateSelectedScenePrompt();
        } catch (error) {
          setSceneImageNotice(error.message || 'シーンプロンプト翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#sceneVideoPromptTranslateBtn')) {
        try {
          await translateSelectedSceneVideoPrompt();
        } catch (error) {
          setSceneVideoNotice(error.message || '動画用プロンプト翻訳に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#scenePromptClearBtn')) {
        clearScenePrompts();
        return;
      }

      if (event.target.closest('#sceneImageGenerateBtn')) {
        try {
          await generateSelectedSceneImage();
        } catch (error) {
          setSceneImageNotice(error.message || 'シーン画像生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#sceneImageGenerateAllBtn')) {
        try {
          await generateAllSceneImages();
        } catch (error) {
          setSceneImageNotice(error.message || '全シーン画像生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#sceneImageCancelBtn')) {
        cancelSceneImageGeneration();
        return;
      }

      if (event.target.closest('#sceneImageClearBtn')) {
        clearSelectedSceneImage();
        return;
      }

      if (event.target.closest('#sceneVideoGenerateBtn')) {
        try {
          await generateSelectedSceneVideo();
        } catch (error) {
          setSceneVideoNotice(error.message || 'シーン動画生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#sceneVideoGenerateAllBtn')) {
        try {
          await generateAllSceneVideos();
        } catch (error) {
          setSceneVideoNotice(error.message || '全シーン動画生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#sceneVideoCancelBtn')) {
        cancelSceneVideoGeneration();
        return;
      }

      if (event.target.closest('#sceneVideoClearBtn')) {
        clearSelectedSceneVideo();
        return;
      }

      if (event.target.closest('#finalMvConcatBtn')) {
        try {
          await concatFinalMvClips();
        } catch (error) {
          setFinalMvNotice(error.message || 'シーンクリップ結合に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#finalMvAutoBtn')) {
        try {
          await autoCreateFinalMv();
        } catch (error) {
          setFinalMvNotice(error.message || '自動制作に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#finalMvRenderBtn')) {
        try {
          await renderFinalMvVideo();
        } catch (error) {
          setFinalMvNotice(error.message || '完成MV生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#finalMvClearBtn')) {
        clearFinalMvResults();
        return;
      }

      if (event.target.closest('#characterImageGenerateBtn')) {
        try {
          await generateCharacterImage();
        } catch (error) {
          setCharacterNotice(error.message || 'キャラ合成画像の生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#characterImageClearBtn')) {
        state.characterStep.characterImage = null;
        setCharacterNotice('キャラ合成画像をクリアしました', 'info');
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.closest('#characterImageFitVideoBtn')) {
        try {
          await fitCharacterImageForVideo();
        } catch (error) {
          setCharacterNotice(error.message || '動画比率への調整に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#characterSheetGenerateBtn')) {
        try {
          await generateCharacterSheet();
        } catch (error) {
          setCharacterNotice(error.message || 'キャラシート生成に失敗しました', 'warning');
          renderDetail();
        }
        return;
      }

      if (event.target.closest('#characterSheetClearBtn')) {
        state.characterStep.characterSheetImage = null;
        setCharacterNotice('キャラシートをクリアしました', 'info');
        renderDetail();
        scheduleSave();
      }
    });

    els.detailBody.addEventListener('change', async (event) => {
      const slotInput = event.target.closest('[data-slot-input]');
      if (slotInput) {
        const index = Number(slotInput.getAttribute('data-slot-input'));
        const file = slotInput.files?.[0] || null;
        if (!file) return;
        try {
          await uploadCharacterRefSlot(index, file);
        } catch (error) {
          setCharacterNotice(error.message || '参照画像のアップロードに失敗しました', 'warning');
          renderDetail();
        }
        slotInput.value = '';
        return;
      }

      if (event.target.matches('#musicImportAudioInput')) {
        const file = event.target.files?.[0] || null;
        if (!file) return;
        try {
          await importMusicAudio(file);
        } catch (error) {
          setMusicNotice(error.message || '外部音楽の読み込みに失敗しました', 'warning');
          renderDetail();
        }
        event.target.value = '';
        return;
      }

      if (event.target.matches('#characterRef3ModeEnabled')) {
        state.characterStep.ref3ModeEnabled = !!event.target.checked;
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#characterRef3ModeSelect')) {
        state.characterStep.ref3UseMode = String(event.target.value || 'background');
        scheduleSave();
        return;
      }

      if (event.target.matches('#characterSheetNobg')) {
        state.characterStep.charSheetNobg = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#storyLyricsEnabled')) {
        state.storyStep.lyricsEnabled = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#storyUseCharacterContext')) {
        state.storyStep.useCharacterContext = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#storySceneCountInput')) {
        updateStorySceneCount(event.target.value);
        return;
      }

      if (event.target.matches('#sceneImageSceneCountInput')) {
        updateStorySceneCount(event.target.value);
        return;
      }

      if (event.target.matches('#storyDurationInput')) {
        state.storyStep.targetDurationSec = Math.max(10, Math.min(600, Number(event.target.value) || 30));
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicTargetDurationInput')) {
        state.storyStep.targetDurationSec = Math.max(10, Math.min(600, Number(event.target.value) || 30));
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        state.canvas.updatedAt = Date.now();
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicVocalLanguageSelect')) {
        state.musicStep.vocalLanguage = String(event.target.value || 'ja');
        if (state.musicStep.vocalLanguage === 'inst') {
          state.musicStep.hasVocals = false;
        }
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicHasVocals')) {
        state.musicStep.hasVocals = !!event.target.checked;
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicInstrumentalFocus')) {
        state.musicStep.instrumentalFocus = !!event.target.checked;
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicUseStoryContext')) {
        state.musicStep.useStoryContext = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicUseCharacterContext')) {
        state.musicStep.useCharacterContext = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicAutoSuggestScenePlanOnImport')) {
        state.musicStep.autoSuggestScenePlanOnImport = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneUseStoryContext')) {
        state.sceneImageStep.useStoryContext = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneUseMusicContext')) {
        state.sceneImageStep.useMusicContext = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneUseCharacterContext')) {
        state.sceneImageStep.useCharacterContext = !!event.target.checked;
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneVideoUseScenePrompt')) {
        state.sceneVideoStep.useScenePrompt = !!event.target.checked;
        const items = getSceneVideoDisplayItems();
        syncSceneVideoItems(items);
        invalidateAllSceneVideos();
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneVideoUseMusicContext')) {
        state.sceneVideoStep.useMusicContext = !!event.target.checked;
        const items = getSceneVideoDisplayItems();
        syncSceneVideoItems(items);
        invalidateAllSceneVideos();
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneVideoAudioOff')) {
        state.sceneVideoStep.audioOff = !!event.target.checked;
        invalidateAllSceneVideos();
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicDurationOverrideInput')) {
        const raw = String(event.target.value || '').trim();
        state.musicStep.durationOverrideSec = raw ? Math.max(10, Math.min(600, Number(raw) || 30)) : null;
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        state.canvas.updatedAt = Date.now();
        renderDetail();
        scheduleSave();
        return;
      }

      if (
        event.target.matches('#musicTrimStartInput')
        || event.target.matches('#musicTrimEndInput')
        || event.target.matches('#musicTrimStartRange')
        || event.target.matches('#musicTrimEndRange')
      ) {
        if (state.musicStep.generatedAudio) {
          const currentRange = getMusicAudioTrimRange();
          const raw = String(event.target.value || '').trim();
          const isStartField = event.target.matches('#musicTrimStartInput') || event.target.matches('#musicTrimStartRange');
          const fallback = isStartField ? currentRange.startSec : currentRange.endSec;
          const nextValue = raw === '' ? fallback : Math.max(0, Number(raw) || fallback);
          if (isStartField) {
            setMusicAudioTrimRange(nextValue, currentRange.endSec);
          } else {
            setMusicAudioTrimRange(currentRange.startSec, nextValue);
          }
          syncMusicTrimInputsFromState();
          renderMusicWaveformPreview();
          scheduleSave();
        }
        return;
      }

      if (event.target.matches('#sceneVideoWorkflowModeSelect')) {
        state.sceneVideoStep.workflowMode = String(event.target.value || 'auto');
        state.sceneVideoStep.fps = getDefaultSceneVideoFps(state.sceneVideoStep.workflowMode);
        invalidateAllSceneVideos();
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneVideoFpsInput')) {
        state.sceneVideoStep.fps = Math.max(8, Math.min(32, Number(event.target.value) || getDefaultSceneVideoFps(state.sceneVideoStep.workflowMode)));
        invalidateAllSceneVideos();
        renderDetail();
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneVideoTransitionSelect')) {
        setSceneVideoNotice('シーン遷移設定を更新しました', 'info');
        updateSceneTransitionType(state.sceneVideoStep.selectedSceneIndex, event.target.value);
        return;
      }

      if (event.target.matches('#scenePromptDurationInput')) {
        updateScenePromptDuration(state.sceneImageStep.selectedSceneIndex, event.target.value);
        return;
      }

      if (event.target.matches('#sceneVideoDurationInput')) {
        updateScenePromptDuration(state.sceneVideoStep.selectedSceneIndex, event.target.value);
        return;
      }
    });

    els.detailBody.addEventListener('dragover', (event) => {
      const slotCard = event.target.closest('[data-slot-card]');
      if (!slotCard) return;
      event.preventDefault();
      slotCard.classList.add('dragover');
    });

    els.detailBody.addEventListener('dragleave', (event) => {
      const slotCard = event.target.closest('[data-slot-card]');
      if (!slotCard) return;
      const related = event.relatedTarget;
      if (related && slotCard.contains(related)) return;
      slotCard.classList.remove('dragover');
    });

    els.detailBody.addEventListener('drop', async (event) => {
      const slotCard = event.target.closest('[data-slot-card]');
      if (!slotCard) return;
      event.preventDefault();
      slotCard.classList.remove('dragover');
      const index = Number(slotCard.getAttribute('data-slot-card'));
      const file = event.dataTransfer?.files?.[0] || null;
      if (!file) return;
      try {
        await uploadCharacterRefSlot(index, file);
      } catch (error) {
        setCharacterNotice(error.message || '参照画像のドロップに失敗しました', 'warning');
        renderDetail();
      }
    });

    els.detailBody.addEventListener('input', (event) => {
      if (event.target.matches('#musicTrimStartRange') || event.target.matches('#musicTrimEndRange')) {
        if (state.musicStep.generatedAudio) {
          const currentRange = getMusicAudioTrimRange();
          const nextValue = Math.max(0, Number(event.target.value) || 0);
          if (event.target.matches('#musicTrimStartRange')) {
            setMusicAudioTrimRange(nextValue, currentRange.endSec);
          } else {
            setMusicAudioTrimRange(currentRange.startSec, nextValue);
          }
          syncMusicTrimInputsFromState();
          renderMusicWaveformPreview();
          scheduleSave();
        }
        return;
      }

      if (event.target.matches('#characterPromptInput')) {
        state.characterStep.imagePrompt = String(event.target.value || '');
        state.characterStep.characterImage = null;
        scheduleSave();
        return;
      }

      if (event.target.matches('#characterAnalysisText')) {
        state.characterStep.keyImageAnalysis = String(event.target.value || '');
        scheduleSave();
        return;
      }

      if (event.target.matches('#storyIdeaInput')) {
        state.storyStep.idea = String(event.target.value || '');
        scheduleSave();
        return;
      }

      if (event.target.matches('#storyScenarioText')) {
        state.storyStep.scenarioText = String(event.target.value || '');
        state.storyStep.generatedOutline = [];
        scheduleSave();
        return;
      }

      if (event.target.matches('#storyWorldNotesInput')) {
        state.storyStep.worldNotes = String(event.target.value || '');
        scheduleSave();
        return;
      }

      if (event.target.matches('#storyGenreInput')) {
        state.storyStep.genre = String(event.target.value || '');
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicPromptInput')) {
        state.musicStep.musicPrompt = String(event.target.value || '');
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicLyricsText')) {
        state.musicStep.lyricsText = String(event.target.value || '');
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicTagsText')) {
        state.musicStep.tagsText = String(event.target.value || '');
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicArrangementNotesInput')) {
        state.musicStep.arrangementNotes = String(event.target.value || '');
        invalidateFinalMvOutputs({ keepClip: true });
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicBpmInput')) {
        state.musicStep.bpm = Math.max(60, Math.min(220, Number(event.target.value) || 118));
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        scheduleSave();
        return;
      }

      if (event.target.matches('#musicKeyInput')) {
        state.musicStep.keySignature = String(event.target.value || '');
        if (!isImportedMusicAudio()) {
          state.musicStep.generatedAudio = null;
        }
        invalidateFinalMvOutputs({ keepClip: true });
        scheduleSave();
        return;
      }

      if (event.target.matches('#scenePromptText')) {
        const prompts = getSceneImageDisplayPrompts();
        const index = Math.max(0, Number(state.sceneImageStep.selectedSceneIndex || 0) || 0);
        if (prompts[index]) {
          prompts[index].prompt = String(event.target.value || '');
          prompts[index].image = null;
          state.sceneImageStep.scenePrompts = prompts;
          invalidateSceneVideoAtIndex(index);
        }
        scheduleSave();
        return;
      }

      if (event.target.matches('#sceneVideoPromptText')) {
        const items = getSceneVideoDisplayItems();
        const index = Math.max(0, Number(state.sceneVideoStep.selectedSceneIndex || 0) || 0);
        if (items[index]) {
          items[index].prompt = String(event.target.value || '');
          items[index].promptCustomized = true;
          items[index].video = null;
          syncSceneVideoItems(items);
          invalidateFinalMvOutputs();
        }
        scheduleSave();
        return;
      }
    });

    els.canvasNameInput.addEventListener('input', (event) => {
      state.canvas.name = String(event.target.value || '').slice(0, 80);
      state.canvas.updatedAt = Date.now();
      renderCanvasSummary();
      scheduleSave();
    });

    els.newCanvasBtn.addEventListener('click', () => {
      createNewCanvas();
    });

    els.resumeCanvasBtn.addEventListener('click', () => {
      renderAll();
      renderSaveStatus('前回のキャンバスを表示中', true);
    });

    els.imagePreviewCloseBtn?.addEventListener('click', () => {
      closeImagePreview();
    });

    els.imagePreviewModal?.addEventListener('click', (event) => {
      if (event.target.closest('[data-image-preview-close]')) {
        closeImagePreview();
      }
    });

    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && els.imagePreviewModal && !els.imagePreviewModal.classList.contains('hidden')) {
        closeImagePreview();
      }
    });

    window.addEventListener('resize', () => {
      if (String(getCurrentStep()?.id) === 'final_mv') {
        syncFinalMvActionButtonWidths();
      }
    });
  }

  async function init() {
    Object.assign(els, {
      presetSelect: $('presetSelect'),
      presetOverview: $('presetOverview'),
      flowPreview: $('flowPreview'),
      detailBody: $('detailBody'),
      detailStepSummary: $('detailStepSummary'),
      detailTitle: $('detailTitle'),
      detailSubtitle: $('detailSubtitle'),
      detailModeBadge: $('detailModeBadge'),
      canvasTitle: $('canvasTitle'),
      canvasUpdatedAt: $('canvasUpdatedAt'),
      canvasNameInput: $('canvasNameInput'),
      summaryPreset: $('summaryPreset'),
      summaryMode: $('summaryMode'),
      summaryStep: $('summaryStep'),
      summaryHint: $('summaryHint'),
      resumeStatus: $('resumeStatus'),
      newCanvasBtn: $('newCanvasBtn'),
      resumeCanvasBtn: $('resumeCanvasBtn'),
      imagePreviewModal: $('imagePreviewModal'),
      imagePreviewModalImage: $('imagePreviewModalImage'),
      imagePreviewCloseBtn: $('imagePreviewCloseBtn'),
      imagePreviewTitle: $('imagePreviewTitle'),
      imagePreviewCaption: $('imagePreviewCaption'),
    });

    renderSaveStatus('読み込み中', false);

    try {
      await loadConfig();
      await hydrateState();
      ensureUsableState();
      await refreshCharacterRegistry({ rerender: false });
      renderAll();
      bindEvents();
      scheduleSave();
    } catch (error) {
      console.error('[production] init failed', error);
      els.detailBody.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⚠️</div>
          <h3>試作画面の初期化に失敗しました</h3>
          <p>${escapeHtml(error?.message || String(error))}</p>
        </div>
      `;
      renderSaveStatus('初期化失敗', false);
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
