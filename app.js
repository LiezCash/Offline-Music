class MusicDatabase {
  constructor() {
    this.dbName = 'offline-music-pwa';
    this.storeName = 'tracks';
    this.version = 1;
    this.dbPromise = this.open();
  }

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          store.createIndex('addedAt', 'addedAt');
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async transaction(mode, callback) {
    const db = await this.dbPromise;

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, mode);
      const store = transaction.objectStore(this.storeName);
      const request = callback(store);

      transaction.oncomplete = () => resolve(request?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  getAllTracks() {
    return this.transaction('readonly', (store) => store.getAll());
  }

  saveTrack(track) {
    return this.transaction('readwrite', (store) => store.put(track));
  }

  deleteTrack(id) {
    return this.transaction('readwrite', (store) => store.delete(id));
  }

  clearTracks() {
    return this.transaction('readwrite', (store) => store.clear());
  }
}

const db = new MusicDatabase();
const state = {
  tracks: [],
  currentTrackId: null,
  currentObjectUrl: null,
};

const elements = {
  addTracksButton: document.querySelector('#addTracksButton'),
  audioPlayer: document.querySelector('#audioPlayer'),
  clearLibraryButton: document.querySelector('#clearLibraryButton'),
  connectionDot: document.querySelector('#connectionDot'),
  connectionStatus: document.querySelector('#connectionStatus'),
  currentTime: document.querySelector('#currentTime'),
  currentTrackTitle: document.querySelector('#currentTrackTitle'),
  durationTime: document.querySelector('#durationTime'),
  emptyState: document.querySelector('#emptyState'),
  fileInput: document.querySelector('#fileInput'),
  librarySummary: document.querySelector('#librarySummary'),
  playPauseButton: document.querySelector('#playPauseButton'),
  seekBar: document.querySelector('#seekBar'),
  trackList: document.querySelector('#trackList'),
  trackTemplate: document.querySelector('#trackTemplate'),
  volumeControl: document.querySelector('#volumeControl'),
};

function createTrackId(file) {
  return `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0:00';
  }

  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${remainingSeconds}`;
}

function formatFileSize(bytes) {
  if (!bytes) {
    return '0 Б';
  }

  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function getAudioDuration(file) {
  return new Promise((resolve) => {
    const audio = new Audio();
    const objectUrl = URL.createObjectURL(file);

    const cleanup = () => {
      URL.revokeObjectURL(objectUrl);
      audio.removeAttribute('src');
      audio.load();
    };

    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      cleanup();
      resolve(Number.isFinite(duration) ? duration : 0);
    };
    audio.onerror = () => {
      cleanup();
      resolve(0);
    };
    audio.src = objectUrl;
  });
}

function updateConnectionStatus() {
  const isOnline = navigator.onLine;
  elements.connectionDot.classList.toggle('is-online', isOnline);
  elements.connectionStatus.textContent = isOnline ? 'Онлайн' : 'Офлайн';
}

function updateLibrarySummary() {
  const totalSize = state.tracks.reduce((sum, track) => sum + track.size, 0);
  const tracksWord = state.tracks.length === 1 ? 'трек' : 'треков';
  elements.librarySummary.textContent = state.tracks.length
    ? `${state.tracks.length} ${tracksWord} · ${formatFileSize(totalSize)}`
    : 'Библиотека пуста';
  elements.emptyState.hidden = state.tracks.length > 0;
  elements.clearLibraryButton.disabled = state.tracks.length === 0;
}

function renderTracks() {
  elements.trackList.replaceChildren();

  state.tracks.forEach((track) => {
    const item = elements.trackTemplate.content.firstElementChild.cloneNode(true);
    const mainButton = item.querySelector('.track-card__main');
    const title = item.querySelector('.track-card__title');
    const meta = item.querySelector('.track-card__meta');
    const deleteButton = item.querySelector('.delete-track');

    item.classList.toggle('is-active', track.id === state.currentTrackId);
    title.textContent = track.name;
    meta.textContent = `${formatDuration(track.duration)} · ${formatFileSize(track.size)}`;
    mainButton.addEventListener('click', () => selectTrack(track.id, true));
    deleteButton.addEventListener('click', () => removeTrack(track.id));

    elements.trackList.append(item);
  });

  updateLibrarySummary();
}

function setPlayerEnabled(enabled) {
  elements.playPauseButton.disabled = !enabled;
  elements.seekBar.disabled = !enabled;
}

function releaseCurrentObjectUrl() {
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = null;
  }
}

function stopPlayback() {
  elements.audioPlayer.pause();
  elements.audioPlayer.removeAttribute('src');
  elements.audioPlayer.load();
  elements.currentTrackTitle.textContent = 'Выберите трек';
  elements.currentTime.textContent = '0:00';
  elements.durationTime.textContent = '0:00';
  elements.seekBar.value = 0;
  elements.playPauseButton.textContent = '▶';
  elements.playPauseButton.setAttribute('aria-label', 'Воспроизвести');
  setPlayerEnabled(false);
  releaseCurrentObjectUrl();
}

function updatePlayButton() {
  const isPlaying = !elements.audioPlayer.paused;
  elements.playPauseButton.textContent = isPlaying ? '⏸' : '▶';
  elements.playPauseButton.setAttribute('aria-label', isPlaying ? 'Пауза' : 'Воспроизвести');
}

function updateProgress() {
  const { currentTime, duration } = elements.audioPlayer;
  elements.currentTime.textContent = formatDuration(currentTime);
  elements.durationTime.textContent = formatDuration(duration);
  elements.seekBar.value = Number.isFinite(duration) && duration > 0 ? (currentTime / duration) * 100 : 0;
}

async function selectTrack(id, autoplay = false) {
  const track = state.tracks.find((candidate) => candidate.id === id);
  if (!track) {
    return;
  }

  releaseCurrentObjectUrl();
  state.currentTrackId = id;
  state.currentObjectUrl = URL.createObjectURL(track.blob);
  elements.audioPlayer.src = state.currentObjectUrl;
  elements.currentTrackTitle.textContent = track.name;
  setPlayerEnabled(true);
  renderTracks();

  if (autoplay) {
    await elements.audioPlayer.play();
  }
}

async function addTracks(files) {
  const mp3Files = [...files].filter((file) => file.type === 'audio/mpeg' || file.name.toLowerCase().endsWith('.mp3'));

  for (const file of mp3Files) {
    const duration = await getAudioDuration(file);
    const track = {
      id: createTrackId(file),
      name: file.name,
      size: file.size,
      type: file.type || 'audio/mpeg',
      duration,
      addedAt: Date.now(),
      blob: file,
    };

    await db.saveTrack(track);
    state.tracks.push(track);
  }

  state.tracks.sort((a, b) => b.addedAt - a.addedAt);
  renderTracks();

  if (!state.currentTrackId && state.tracks.length) {
    await selectTrack(state.tracks[0].id, false);
  }
}

async function removeTrack(id) {
  await db.deleteTrack(id);
  state.tracks = state.tracks.filter((track) => track.id !== id);

  if (state.currentTrackId === id) {
    state.currentTrackId = null;
    stopPlayback();
    if (state.tracks.length) {
      await selectTrack(state.tracks[0].id, false);
    }
  }

  renderTracks();
}

async function clearLibrary() {
  if (!state.tracks.length || !confirm('Удалить все треки из локальной библиотеки?')) {
    return;
  }

  await db.clearTracks();
  state.tracks = [];
  state.currentTrackId = null;
  stopPlayback();
  renderTracks();
}

async function loadLibrary() {
  state.tracks = await db.getAllTracks();
  state.tracks.sort((a, b) => b.addedAt - a.addedAt);
  renderTracks();

  if (state.tracks.length) {
    await selectTrack(state.tracks[0].id, false);
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service Worker не зарегистрирован:', error);
    });
  });
}

function bindEvents() {
  elements.addTracksButton.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', async (event) => {
    await addTracks(event.target.files);
    elements.fileInput.value = '';
  });
  elements.clearLibraryButton.addEventListener('click', clearLibrary);
  elements.playPauseButton.addEventListener('click', async () => {
    if (elements.audioPlayer.paused) {
      await elements.audioPlayer.play();
    } else {
      elements.audioPlayer.pause();
    }
  });
  elements.seekBar.addEventListener('input', () => {
    const duration = elements.audioPlayer.duration;
    if (Number.isFinite(duration)) {
      elements.audioPlayer.currentTime = (Number(elements.seekBar.value) / 100) * duration;
    }
  });
  elements.volumeControl.addEventListener('input', () => {
    elements.audioPlayer.volume = Number(elements.volumeControl.value);
  });
  elements.audioPlayer.addEventListener('play', updatePlayButton);
  elements.audioPlayer.addEventListener('pause', updatePlayButton);
  elements.audioPlayer.addEventListener('timeupdate', updateProgress);
  elements.audioPlayer.addEventListener('loadedmetadata', updateProgress);
  elements.audioPlayer.addEventListener('ended', updatePlayButton);
  window.addEventListener('online', updateConnectionStatus);
  window.addEventListener('offline', updateConnectionStatus);
}

async function init() {
  elements.audioPlayer.volume = Number(elements.volumeControl.value);
  setPlayerEnabled(false);
  bindEvents();
  updateConnectionStatus();
  registerServiceWorker();

  try {
    await loadLibrary();
  } catch (error) {
    console.error('Не удалось загрузить библиотеку:', error);
    elements.librarySummary.textContent = 'Ошибка загрузки библиотеки';
  }
}

init();
