(() => {
  const socket = io();

  const qs = new URLSearchParams(window.location.search);
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const roomId = pathParts[pathParts.length - 1];
  const adminToken = qs.get('admin') || null;

  const refs = {
    title: document.getElementById('room-title'),
    whoami: document.getElementById('whoami'),
    notice: document.getElementById('notice'),
    playerContainer: document.getElementById('player-container'),
    adminControls: document.getElementById('admin-controls'),
    btnPlay: document.getElementById('btn-play'),
    btnPause: document.getElementById('btn-pause'),
    btnSync: document.getElementById('btn-sync'),
    chatLog: document.getElementById('chat-log'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    chatName: document.getElementById('chat-name'),
  };

  const state = {
    role: 'guest',
    room: null,
    suppressEvents: false,
    ytPlayer: null,
    html5Video: null,
  };

  function setNotice(text) {
    refs.notice.textContent = text || '';
  }

  function formatTime(seconds) {
    const s = Math.floor(seconds || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (h > 0 ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  function buildYouTubePlayer(videoId, showControls) {
    // Clean container
    refs.playerContainer.innerHTML = '<div id="yt-player"></div>';
    state.ytPlayer = new YT.Player('yt-player', {
      width: '100%','height': '100%',
      videoId,
      playerVars: {
        autoplay: 0,
        controls: showControls ? 1 : 0,
        disablekb: showControls ? 0 : 1,
        modestbranding: 1,
        rel: 0,
        iv_load_policy: 3,
      },
      events: {
        onReady: (e) => {
          if (state.room) {
            const { isPlaying, currentTime } = state.room;
            applyStateToPlayer(isPlaying, currentTime);
          }
        },
        onStateChange: (e) => {
          if (state.role !== 'admin') return;
          if (state.suppressEvents) return;
          const player = state.ytPlayer;
          if (!player) return;
          const t = player.getCurrentTime ? player.getCurrentTime() : 0;
          if (e.data === YT.PlayerState.PLAYING) {
            emitAdminAction('play', t);
          } else if (e.data === YT.PlayerState.PAUSED) {
            emitAdminAction('pause', t);
          }
        }
      }
    });
  }

  function buildHtml5Player(srcUrl, showControls) {
    refs.playerContainer.innerHTML = '';
    const video = document.createElement('video');
    video.id = 'html5-video';
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.disablePictureInPicture = true;
    video.controls = showControls;
    video.src = srcUrl;
    video.style.width = '100%';
    video.style.height = '100%';
    refs.playerContainer.appendChild(video);
    state.html5Video = video;

    video.addEventListener('loadedmetadata', () => {
      if (state.room) {
        const { isPlaying, currentTime } = state.room;
        applyStateToPlayer(isPlaying, currentTime);
      }
    });

    if (showControls) {
      video.addEventListener('play', () => {
        if (state.suppressEvents) return;
        emitAdminAction('play', video.currentTime || 0);
      });
      video.addEventListener('pause', () => {
        if (state.suppressEvents) return;
        emitAdminAction('pause', video.currentTime || 0);
      });
      // Basic seek detection
      let lastTime = 0;
      setInterval(() => {
        if (!video.seeking && !video.paused) {
          lastTime = video.currentTime;
          return;
        }
        const delta = Math.abs(video.currentTime - lastTime);
        if (delta > 1.0 && !state.suppressEvents) {
          emitAdminAction('seek', video.currentTime || 0);
          lastTime = video.currentTime;
        }
      }, 1000);
    }
  }

  function getCurrentTime() {
    if (state.ytPlayer && state.ytPlayer.getCurrentTime) return state.ytPlayer.getCurrentTime();
    if (state.html5Video) return state.html5Video.currentTime || 0;
    return 0;
  }

  function playAt(time) {
    state.suppressEvents = true;
    if (state.ytPlayer) {
      try {
        if (typeof time === 'number') state.ytPlayer.seekTo(time, true);
        state.ytPlayer.playVideo();
      } catch (_) {}
    } else if (state.html5Video) {
      try {
        if (typeof time === 'number') state.html5Video.currentTime = time;
        state.html5Video.play();
      } catch (_) {}
    }
    setTimeout(() => { state.suppressEvents = false; }, 400);
  }

  function pauseAt(time) {
    state.suppressEvents = true;
    if (state.ytPlayer) {
      try {
        if (typeof time === 'number') state.ytPlayer.seekTo(time, true);
        state.ytPlayer.pauseVideo();
      } catch (_) {}
    } else if (state.html5Video) {
      try {
        if (typeof time === 'number') state.html5Video.currentTime = time;
        state.html5Video.pause();
      } catch (_) {}
    }
    setTimeout(() => { state.suppressEvents = false; }, 400);
  }

  function seekTo(time) {
    state.suppressEvents = true;
    if (state.ytPlayer) {
      try { state.ytPlayer.seekTo(time, true); } catch (_) {}
    } else if (state.html5Video) {
      try { state.html5Video.currentTime = time; } catch (_) {}
    }
    setTimeout(() => { state.suppressEvents = false; }, 300);
  }

  function applyStateToPlayer(isPlaying, currentTime) {
    if (isPlaying) playAt(currentTime);
    else pauseAt(currentTime);
  }

  function emitAdminAction(action, time) {
    if (state.role !== 'admin') return;
    socket.emit('admin-action', { roomId, action, time });
  }

  function appendChatMessage({ user, text, ts }) {
    const div = document.createElement('div');
    div.className = 'chat-item';
    const time = new Date(ts);
    div.innerHTML = `<span class="chat-meta">[${time.toLocaleTimeString()}] <strong>${escapeHtml(user)}</strong>:</span> ${escapeHtml(text)}`;
    refs.chatLog.appendChild(div);
    refs.chatLog.scrollTop = refs.chatLog.scrollHeight;
  }

  function appendSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'chat-item system';
    div.textContent = text;
    refs.chatLog.appendChild(div);
    refs.chatLog.scrollTop = refs.chatLog.scrollHeight;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Socket events
  socket.on('connect', () => {
    socket.emit('join-room', {
      roomId,
      adminToken,
      userName: refs.chatName.value || 'Guest'
    });
  });

  socket.on('room-joined', ({ role, room, chat }) => {
    state.role = role;
    state.room = room;

    refs.title.textContent = `${room.name}`;
    refs.whoami.textContent = `Role: ${role}`;

    // Show admin buttons only to admin
    if (role === 'admin') {
      refs.adminControls.classList.remove('hidden');
    } else {
      refs.adminControls.classList.add('hidden');
    }

    // Build player
    if (room.video.type === 'youtube') {
      const showControls = role === 'admin';
      // If API not yet ready, wait until onYouTubeIframeAPIReady sets global
      if (window.YT && window.YT.Player) {
        buildYouTubePlayer(room.video.youtubeId, showControls);
      } else {
        window.onYouTubeIframeAPIReady = () => {
          buildYouTubePlayer(room.video.youtubeId, showControls);
        };
      }
    } else {
      buildHtml5Player(room.video.srcUrl, role === 'admin');
    }

    // Load chat history
    refs.chatLog.innerHTML = '';
    (chat || []).forEach(appendChatMessage);

    setNotice('');
  });

  socket.on('video-event', ({ action, time }) => {
    if (action === 'play') {
      playAt(time);
    } else if (action === 'pause') {
      pauseAt(time);
    } else if (action === 'seek') {
      seekTo(time);
    }
  });

  socket.on('sync-state', ({ isPlaying, currentTime }) => {
    applyStateToPlayer(isPlaying, currentTime);
  });

  socket.on('chat-message', appendChatMessage);
  socket.on('system-message', (m) => appendSystemMessage(m.message));
  socket.on('error-message', (m) => setNotice(m.message || 'Error'));

  // Admin buttons
  refs.btnPlay.addEventListener('click', () => emitAdminAction('play', getCurrentTime()));
  refs.btnPause.addEventListener('click', () => emitAdminAction('pause', getCurrentTime()));
  refs.btnSync.addEventListener('click', () => socket.emit('request-sync', { roomId }));

  // Chat form
  refs.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = refs.chatInput.value.trim();
    if (!text) return;
    const user = refs.chatName.value.trim() || 'Guest';
    socket.emit('chat-message', { roomId, user, text });
    refs.chatInput.value = '';
  });
})();