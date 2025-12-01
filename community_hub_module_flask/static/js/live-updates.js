/**
 * Live Updates - Polling for live stream status
 */

let liveUpdateInterval = null;
let lastLiveUpdate = null;

function initLiveUpdates(intervalMs) {
    if (liveUpdateInterval) {
        clearInterval(liveUpdateInterval);
    }

    // Initial fetch
    fetchLiveStreams();

    // Start polling
    liveUpdateInterval = setInterval(fetchLiveStreams, intervalMs || 30000);

    // Stop polling when page is hidden
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            clearInterval(liveUpdateInterval);
        } else {
            fetchLiveStreams();
            liveUpdateInterval = setInterval(fetchLiveStreams, intervalMs || 30000);
        }
    });
}

async function fetchLiveStreams() {
    try {
        const response = await fetch('/api/v1/live');
        if (!response.ok) throw new Error('Failed to fetch live streams');

        const data = await response.json();
        if (data.success) {
            updateLiveStreamsUI(data.streams);
            lastLiveUpdate = data.timestamp;
        }
    } catch (error) {
        console.error('Live update error:', error);
    }
}

function updateLiveStreamsUI(streams) {
    const container = document.getElementById('live-streams-container');
    if (!container) return;

    // Only update if we have streams
    if (!streams || streams.length === 0) {
        container.innerHTML = `
            <div class="column is-12">
                <p class="has-text-grey has-text-centered">No streams are currently live.</p>
            </div>
        `;
        return;
    }

    // Build new HTML
    let html = '';
    streams.forEach(stream => {
        html += `
            <div class="column is-4 fade-in">
                <div class="card stream-card">
                    ${stream.thumbnail_url ? `
                    <div class="card-image">
                        <figure class="image is-16by9">
                            <img src="${stream.thumbnail_url}" alt="${stream.channel_name}">
                        </figure>
                        <span class="viewer-count tag is-dark">
                            <i class="fas fa-eye mr-1"></i>${formatNumber(stream.viewer_count)}
                        </span>
                    </div>
                    ` : ''}
                    <div class="card-content">
                        <div class="media">
                            <div class="media-content">
                                <p class="title is-5">${stream.channel_name}</p>
                                <p class="subtitle is-6 has-text-grey">
                                    ${stream.title ? truncate(stream.title, 50) : 'Streaming'}
                                </p>
                                ${stream.game ? `<span class="tag is-info is-light">${stream.game}</span>` : ''}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'k';
    }
    return num.toString();
}

function truncate(str, len) {
    if (str.length <= len) return str;
    return str.substring(0, len) + '...';
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initLiveUpdates, fetchLiveStreams };
}
