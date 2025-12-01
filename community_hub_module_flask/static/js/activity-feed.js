/**
 * Activity Feed - Polling for community activity updates
 */

let activityInterval = null;
let lastActivityTimestamp = null;
let communityId = null;

function initActivityFeed(commId, intervalMs) {
    communityId = commId;

    if (activityInterval) {
        clearInterval(activityInterval);
    }

    // Get initial timestamp from the last activity item
    const lastItem = document.querySelector('.activity-item:first-child');
    if (lastItem && lastItem.dataset.timestamp) {
        lastActivityTimestamp = lastItem.dataset.timestamp;
    }

    // Start polling
    activityInterval = setInterval(fetchNewActivity, intervalMs || 60000);

    // Stop polling when page is hidden
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            clearInterval(activityInterval);
        } else {
            fetchNewActivity();
            activityInterval = setInterval(fetchNewActivity, intervalMs || 60000);
        }
    });
}

async function fetchNewActivity() {
    if (!communityId) return;

    try {
        let url = `/api/v1/communities/${communityId}/activity?limit=10`;
        if (lastActivityTimestamp) {
            url += `&since=${encodeURIComponent(lastActivityTimestamp)}`;
        }

        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to fetch activity');

        const data = await response.json();
        if (data.success && data.activities.length > 0) {
            prependActivities(data.activities);
            lastActivityTimestamp = data.timestamp;
        }
    } catch (error) {
        console.error('Activity fetch error:', error);
    }
}

function prependActivities(activities) {
    const container = document.getElementById('activity-feed');
    if (!container) return;

    // Build HTML for new activities
    activities.reverse().forEach(activity => {
        const html = createActivityHTML(activity);
        const temp = document.createElement('div');
        temp.innerHTML = html;
        const newItem = temp.firstElementChild;
        newItem.classList.add('new');

        // Insert at the beginning
        if (container.firstChild) {
            container.insertBefore(newItem, container.firstChild);
        } else {
            container.appendChild(newItem);
        }

        // Limit total items
        const items = container.querySelectorAll('.activity-item');
        if (items.length > 50) {
            items[items.length - 1].remove();
        }
    });
}

function createActivityHTML(activity) {
    const pointsClass = activity.points > 0 ? 'is-success' : 'is-danger';
    const pointsPrefix = activity.points > 0 ? '+' : '';

    return `
        <div class="activity-item level is-mobile" data-platform="${activity.platform}" data-timestamp="${activity.timestamp}">
            <div class="level-left">
                <div>
                    <span class="platform-badge ${activity.platform}-bg mr-2">
                        <i class="fab fa-${activity.platform}"></i>
                    </span>
                    <strong>${activity.user_name}</strong>
                    <span class="has-text-grey">${activity.event_label}</span>
                    ${activity.details && activity.details.amount ? `<span class="tag is-info is-small">${activity.details.amount}</span>` : ''}
                    <br>
                    <span class="is-size-7 has-text-grey">
                        ${activity.relative_time}
                    </span>
                </div>
            </div>
            <div class="level-right">
                <span class="tag ${pointsClass}">
                    ${pointsPrefix}${activity.points} pts
                </span>
            </div>
        </div>
    `;
}

// Export for module use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initActivityFeed, fetchNewActivity };
}
