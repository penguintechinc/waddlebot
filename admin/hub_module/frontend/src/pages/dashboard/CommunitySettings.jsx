import { useParams } from 'react-router-dom';

function CommunitySettings() {
  const { id } = useParams();
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Community Settings</h1>
      <div className="card p-6">
        <p className="text-slate-600">Settings for community {id} - Coming soon</p>
      </div>
    </div>
  );
}

export default CommunitySettings;
