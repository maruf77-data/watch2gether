document.addEventListener('DOMContentLoaded', () => {
  const createForm = document.getElementById('create-form');
  const roomNameInput = document.getElementById('room-name');
  const videoUrlInput = document.getElementById('video-url');
  const linksBox = document.getElementById('links');
  const adminUrlEl = document.getElementById('admin-url');
  const guestUrlEl = document.getElementById('guest-url');
  const copyAdminBtn = document.getElementById('copy-admin');
  const copyGuestBtn = document.getElementById('copy-guest');

  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const roomName = roomNameInput.value.trim();
    const videoUrl = videoUrlInput.value.trim();
    if (!roomName || !videoUrl) return;
    try {
      const res = await fetch('/api/create-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomName, videoUrl })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create room');

      const origin = window.location.origin;
      const adminHref = origin + data.adminUrl;
      const guestHref = origin + data.guestUrl;

      adminUrlEl.textContent = adminHref;
      adminUrlEl.href = adminHref;
      guestUrlEl.textContent = guestHref;
      guestUrlEl.href = guestHref;
      linksBox.classList.remove('hidden');
    } catch (err) {
      alert(err.message || 'Error creating room');
    }
  });

  copyAdminBtn.addEventListener('click', () => {
    const text = adminUrlEl.href;
    navigator.clipboard.writeText(text);
  });
  copyGuestBtn.addEventListener('click', () => {
    const text = guestUrlEl.href;
    navigator.clipboard.writeText(text);
  });

  const joinForm = document.getElementById('join-form');
  const joinUrl = document.getElementById('join-url');
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const href = joinUrl.value.trim();
    if (!href) return;
    window.location.href = href;
  });
});