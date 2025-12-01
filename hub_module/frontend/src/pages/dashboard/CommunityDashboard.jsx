import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { communityApi } from '../../services/api';

function CommunityDashboard() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDashboard() {
      try {
        const response = await communityApi.getDashboard(id);
        setData(response.data);
      } catch (err) {
        console.error('Failed to fetch dashboard:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchDashboard();
  }, [id]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!data) {
    return <div className="text-center py-12 text-slate-500">Failed to load dashboard</div>;
  }

  const { community, membership, recentActivity, liveStreams } = data;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center space-x-4">
          <div className="w-16 h-16 rounded-xl bg-primary-100 flex items-center justify-center overflow-hidden">
            {community.logoUrl ? (
              <img src={community.logoUrl} alt={community.displayName} className="w-full h-full object-cover" />
            ) : (
              <span className="text-3xl">🐧</span>
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold">{community.displayName}</h1>
            <p className="text-slate-600">{membership.role.replace('community-', '').replace('-', ' ')}</p>
          </div>
        </div>
        {['community-owner', 'community-admin', 'moderator'].includes(membership.role) && (
          <Link to={`/admin/${id}`} className="btn btn-primary">
            Admin Panel
          </Link>
        )}
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Stats cards */}
        <div className="lg:col-span-2 space-y-6">
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="card p-4">
              <div className="text-2xl font-bold text-primary-600">{community.memberCount}</div>
              <div className="text-slate-600 text-sm">Members</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-green-600">{membership.reputationScore}</div>
              <div className="text-slate-600 text-sm">Your Rep</div>
            </div>
            <div className="card p-4">
              <div className="text-2xl font-bold text-purple-600">{liveStreams.length}</div>
              <div className="text-slate-600 text-sm">Live Now</div>
            </div>
          </div>

          {/* Recent Activity */}
          <div className="card">
            <div className="card-header">
              <h2 className="font-semibold">Recent Activity</h2>
            </div>
            <div className="divide-y divide-slate-200">
              {recentActivity.length === 0 ? (
                <div className="p-4 text-slate-500 text-center">No recent activity</div>
              ) : (
                recentActivity.slice(0, 5).map((activity) => (
                  <div key={activity.id} className="p-4">
                    <p className="text-sm">{activity.description}</p>
                    <p className="text-xs text-slate-500 mt-1">
                      {new Date(activity.createdAt).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Live Streams */}
          {liveStreams.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2 className="font-semibold flex items-center space-x-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
                  </span>
                  <span>Live Now</span>
                </h2>
              </div>
              <div className="divide-y divide-slate-200">
                {liveStreams.map((stream) => (
                  <a
                    key={stream.entityId}
                    href={`https://twitch.tv/${stream.channelName}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-4 hover:bg-slate-50"
                  >
                    <div className="font-medium">{stream.channelName}</div>
                    <div className="text-sm text-slate-600 truncate">{stream.title}</div>
                    <div className="text-xs text-slate-500 mt-1">
                      {stream.viewerCount.toLocaleString()} viewers
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Quick Links */}
          <div className="card">
            <div className="card-header">
              <h2 className="font-semibold">Quick Links</h2>
            </div>
            <div className="p-2">
              <Link
                to={`/dashboard/community/${id}/settings`}
                className="block px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg"
              >
                Community Settings
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default CommunityDashboard;
