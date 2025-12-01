import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { publicApi } from '../../services/api';

function CommunitiesPage() {
  const [communities, setCommunities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(null);

  useEffect(() => {
    async function fetchCommunities() {
      setLoading(true);
      try {
        const response = await publicApi.getCommunities({ page, limit: 12 });
        setCommunities(response.data.communities);
        setPagination(response.data.pagination);
      } catch (err) {
        console.error('Failed to fetch communities:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchCommunities();
  }, [page]);

  const platformIcon = (platform) => {
    switch (platform) {
      case 'discord': return '💬';
      case 'twitch': return '📺';
      case 'slack': return '💼';
      default: return '🌐';
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-3xl font-bold mb-4">Discover Communities</h1>
        <p className="text-slate-600">Browse public communities using WaddleBot</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
        </div>
      ) : (
        <>
          <div className="grid md:grid-cols-3 lg:grid-cols-4 gap-6">
            {communities.map((community) => (
              <Link
                key={community.id}
                to={`/communities/${community.id}`}
                className="card hover:shadow-md transition-shadow"
              >
                <div className="aspect-video bg-slate-100 rounded-t-xl flex items-center justify-center">
                  {community.logoUrl ? (
                    <img
                      src={community.logoUrl}
                      alt={community.displayName}
                      className="w-full h-full object-cover rounded-t-xl"
                    />
                  ) : (
                    <span className="text-4xl">🐧</span>
                  )}
                </div>
                <div className="p-4">
                  <div className="flex items-center space-x-2 mb-1">
                    <span>{platformIcon(community.primaryPlatform)}</span>
                    <h3 className="font-semibold truncate">{community.displayName}</h3>
                  </div>
                  <p className="text-sm text-slate-600 line-clamp-2">
                    {community.description || 'No description'}
                  </p>
                  <div className="mt-3 text-xs text-slate-500">
                    {community.memberCount} members
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Pagination */}
          {pagination && pagination.totalPages > 1 && (
            <div className="flex justify-center mt-8 space-x-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn btn-secondary disabled:opacity-50"
              >
                Previous
              </button>
              <span className="px-4 py-2 text-slate-600">
                Page {page} of {pagination.totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                disabled={page === pagination.totalPages}
                className="btn btn-secondary disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}

          {communities.length === 0 && (
            <div className="text-center py-12 text-slate-500">
              No public communities found
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default CommunitiesPage;
