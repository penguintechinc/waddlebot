import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { adminApi } from '../../services/api';

function AdminMembers() {
  const { communityId } = useParams();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    async function fetchMembers() {
      setLoading(true);
      try {
        const response = await adminApi.getMembers(communityId, { page, limit: 25, search });
        setMembers(response.data.members);
        setPagination(response.data.pagination);
      } catch (err) {
        console.error('Failed to fetch members:', err);
      } finally {
        setLoading(false);
      }
    }
    fetchMembers();
  }, [communityId, page, search]);

  const roleColor = (role) => {
    switch (role) {
      case 'community-owner': return 'badge-gold';
      case 'community-admin': return 'bg-purple-500/20 text-purple-300 border border-purple-500/30';
      case 'moderator': return 'badge-sky';
      default: return 'bg-navy-700 text-navy-300 border border-navy-600';
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-sky-100">Members</h1>
        <input
          type="search"
          placeholder="Search members..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="input w-64"
        />
      </div>

      <div className="card overflow-hidden">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Rep</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan="4" className="p-12 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gold-400 mx-auto"></div>
                </td>
              </tr>
            ) : members.length === 0 ? (
              <tr>
                <td colSpan="4" className="p-12 text-center text-navy-400">
                  No members found
                </td>
              </tr>
            ) : (
              members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <div className="flex items-center space-x-3">
                      {member.avatarUrl ? (
                        <img src={member.avatarUrl} alt="" className="w-8 h-8 rounded-full" />
                      ) : (
                        <div className="w-8 h-8 rounded-full bg-navy-700 flex items-center justify-center text-sm">
                          {member.username?.[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <div>
                        <div className="font-medium text-sky-100">{member.username || 'Unknown'}</div>
                        <div className="text-xs text-navy-500">{member.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${roleColor(member.role)}`}>
                      {member.role.replace('community-', '')}
                    </span>
                  </td>
                  <td>
                    <div className="text-gold-400 font-medium">{member.reputation?.score || 600}</div>
                    <div className="text-xs text-navy-500 capitalize">{member.reputation?.label || 'Fair'}</div>
                  </td>
                  <td className="text-sm text-navy-400">
                    {new Date(member.joinedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {pagination && pagination.totalPages > 1 && (
          <div className="flex justify-between items-center p-4 border-t border-navy-700">
            <span className="text-sm text-navy-400">
              {pagination.total} total members
            </span>
            <div className="flex space-x-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="btn btn-secondary text-sm disabled:opacity-50"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                disabled={page === pagination.totalPages}
                className="btn btn-secondary text-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AdminMembers;
