import {MainMediaType, OmakasePlayer} from '../../src/index';

const defaultUrl = new URL('../dash-sample.mpd', import.meta.url).href;
const form = document.getElementById('stream-form');
const input = document.getElementById('stream-url');
const button = document.getElementById('load-button');
const status = document.getElementById('status');

input.value = new URLSearchParams(location.search).get('url') || defaultUrl;

function showStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

try {
  const player = new OmakasePlayer({playerHtmlElementId: 'omakase-player'});
  let subscription;

  function loadStream() {
    if (!form.reportValidity()) {
      return;
    }
    const url = new URL(input.value);
    if (!['https:', 'http:'].includes(url.protocol)) {
      showStatus('Enter an HTTP or HTTPS MPD URL.', true);
      return;
    }
    subscription?.unsubscribe();
    showStatus('Loading DASH manifest and media segments...');
    subscription = player.loadMainMedia(url.href, {mainMediaType: MainMediaType.DASH}).subscribe({
      next: (media) => {
        showStatus(`Ready - ${media.duration.toFixed(2)} seconds. Press Play to start.`);
      },
      error: (error) => {
        console.error('DASH sample load failed', error);
        showStatus(`Unable to load stream: ${error instanceof Error ? error.message : String(error)}`, true);
      },
    });
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    loadStream();
  });
  window.addEventListener('pagehide', () => {
    subscription?.unsubscribe();
    player.destroy();
  });
  button.disabled = false;
  loadStream();
} catch (error) {
  console.error('DASH sample initialization failed', error);
  showStatus(`Unable to initialize player: ${error instanceof Error ? error.message : String(error)}`, true);
}
