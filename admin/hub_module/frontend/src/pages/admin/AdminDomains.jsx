import { useParams } from 'react-router-dom';

function AdminDomains() {
  const { communityId } = useParams();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Custom Domains</h1>
      <div className="card p-6">
        <p className="text-slate-600">Custom domain configuration for community {communityId} - Coming soon</p>
      </div>
    </div>
  );
}

export default AdminDomains;
