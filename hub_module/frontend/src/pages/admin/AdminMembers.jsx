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
      case 'community-owner': return 'bg-yellow-100 text-yellow-800';
      case 'community-admin': return 'bg-purple-100 text-purple-800';
      case 'moderator': return 'bg-blue-100 text-blue-800';
      default: return 'bg-slate-100 text-slate-800';
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Members</h1>
        <input
          type="search"
          placeholder="Search members..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="input w-64"
        />
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">User</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Role</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Rep</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-slate-500 uppercase">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {loading ? (
              <tr>
                <td colSpan="4" className="px-6 py-12 text-center">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-waddle-orange mx-auto"></div>
                </td>
              </tr>
            ) : members.length === 0 ? (
              <tr>
                <td colSpan="4" className="px-6 py-12 text-center text-slate-500">
                  No members found
                </td>
              </tr>
            ) : (
              members.map((member) => (
                <tr key={member.id} className="hover:bg-slate-50">
                  <td className="px-6 py-4">
                    <div className="font-medium">{member.displayName}</div>
                    <div className="text-xs text-slate-500">{member.platform}</div>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-xs px-2 py-1 rounded-full ${roleColor(member.role)}`}>
                      {member.role.replace('community-', '')}
                    </span>
                  </td>
                  <td className="px-6 py-4">{member.reputationScore}</td>
                  <td className="px-6 py-4 text-sm text-slate-500">
                    {new Date(member.joinedAt).toLocaleDateString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {pagination && pagination.totalPages > 1 && (
          <div className="flex justify-between items-center px-6 py-3 bg-slate-50 border-t border-slate-200">
            <span className="text-sm text-slate-600">
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
