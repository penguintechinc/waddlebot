import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { communityApi } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';

function DashboardHome() {
  const { user } = useAuth();
  const [communities, setCommunities] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchCommunities() {
      try {
        const response = await communityApi.getMyCommunities();
        setCommunities(response.data.communities);
      } catch (err) {
        console.error('Failed to fetch communities:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchCommunities();
  }, []);

  const roleColor = (role) => {
    switch (role) {
      case 'community-owner': return 'bg-yellow-100 text-yellow-800';
      case 'community-admin': return 'bg-purple-100 text-purple-800';
      case 'moderator': return 'bg-blue-100 text-blue-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  const roleLabel = (role) => {
    return role.replace('community-', '').charAt(0).toUpperCase() + role.replace('community-', '').slice(1);
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Welcome back, {user?.username}!</h1>
        <p className="text-slate-600">Manage your communities and explore activity</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
        </div>
      ) : communities.length === 0 ? (
        <div className="card p-12 text-center">
          <div className="text-6xl mb-4">🐧</div>
          <h2 className="text-xl font-semibold mb-2">No Communities Yet</h2>
          <p className="text-slate-600 mb-6">
            You haven't joined any communities yet. Browse available communities to get started.
          </p>
          <Link to="/communities" className="btn btn-primary">
            Browse Communities
          </Link>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {communities.map((community) => (
            <Link
              key={community.id}
              to={`/dashboard/community/${community.id}`}
              className="card hover:shadow-md transition-shadow overflow-hidden"
            >
              <div className="aspect-video bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
                {community.logoUrl ? (
                  <img
                    src={community.logoUrl}
                    alt={community.displayName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-5xl text-white">🐧</span>
                )}
              </div>
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold truncate">{community.displayName}</h3>
                  <span className={`text-xs px-2 py-1 rounded-full ${roleColor(community.role)}`}>
                    {roleLabel(community.role)}
                  </span>
                </div>
                <p className="text-sm text-slate-600 line-clamp-2">
                  {community.description || 'No description'}
                </p>
                <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                  <span>{community.memberCount} members</span>
                  <span>Joined {new Date(community.joinedAt).toLocaleDateString()}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default DashboardHome;
