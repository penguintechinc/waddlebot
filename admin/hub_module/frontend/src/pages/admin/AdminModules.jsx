import { useParams } from 'react-router-dom';

function AdminModules() {
  const { communityId } = useParams();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Module Configuration</h1>
      <div className="card p-6">
        <p className="text-slate-600">Module configuration for community {communityId} - Coming soon</p>
      </div>
    </div>
  );
}

export default AdminModules;
