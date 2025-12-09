import { useState, useEffect } from 'react';
import { kongApi } from '../../../services/api';
import { Plus, Edit2, Trash2, Copy, AlertTriangle } from 'lucide-react';

export default function KongCertificates() {
  const [certificates, setCertificates] = useState([]);
  const [snis, setSNIs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [search, setSearch] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showSNIModal, setShowSNIModal] = useState(false);
  const [selectedCertId, setSelectedCertId] = useState(null);
  const [formData, setFormData] = useState({
    cert: '',
    key: '',
    tags: '',
  });
  const [sniFormData, setSNIFormData] = useState({
    name: '',
    certificate_id: '',
  });

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      const [certsRes, snisRes] = await Promise.all([
        kongApi.getKongCertificates({ search }),
        kongApi.getKongSNIs(),
      ]);
      setCertificates(certsRes.data.data || []);
      setSNIs(snisRes.data.data || []);
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to load certificates');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCertificate = async (e) => {
    e.preventDefault();
    if (!formData.cert || !formData.key) {
      setError('Both certificate and key are required');
      return;
    }

    try {
      const submitData = {
        cert: formData.cert,
        key: formData.key,
        tags: formData.tags ? formData.tags.split(',').map((t) => t.trim()) : undefined,
      };
      await kongApi.createKongCertificate(submitData);
      setSuccess('Certificate created successfully');
      setShowCreateModal(false);
      resetForm();
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create certificate');
    }
  };

  const handleDeleteCertificate = async (certId) => {
    if (!confirm('Are you sure you want to delete this certificate? Associated SNIs will be unaffected.')) return;

    try {
      await kongApi.deleteKongCertificate(certId);
      setSuccess('Certificate deleted successfully');
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete certificate');
    }
  };

  const handleCreateSNI = async (e) => {
    e.preventDefault();
    try {
      await kongApi.createKongSNI({
        name: sniFormData.name,
        certificate_id: sniFormData.certificate_id,
      });
      setSuccess('SNI created successfully');
      setSNIFormData({ name: '', certificate_id: '' });
      setShowSNIModal(false);
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to create SNI');
    }
  };

  const handleDeleteSNI = async (sniId) => {
    if (!confirm('Are you sure you want to delete this SNI?')) return;

    try {
      await kongApi.deleteKongSNI(sniId);
      setSuccess('SNI deleted successfully');
      loadData();
    } catch (err) {
      setError(err.response?.data?.error?.message || 'Failed to delete SNI');
    }
  };

  const resetForm = () => {
    setFormData({
      cert: '',
      key: '',
      tags: '',
    });
  };

  const getExpirationWarning = (cert) => {
    if (!cert.cert_alt_names) return null;

    // Simple expiration check - in real implementation would parse the cert
    const expirationDate = new Date(cert.cert_alt_names?.not_after || cert.not_after);
    const now = new Date();
    const daysUntilExpiration = Math.floor((expirationDate - now) / (1000 * 60 * 60 * 24));

    if (daysUntilExpiration < 0) {
      return { status: 'expired', days: daysUntilExpiration };
    } else if (daysUntilExpiration < 30) {
      return { status: 'warning', days: daysUntilExpiration };
    }
    return null;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setSuccess('Copied to clipboard');
    setTimeout(() => setSuccess(null), 2000);
  };

  const filteredCertificates = certificates.filter((cert) =>
    cert.id?.toLowerCase().includes(search.toLowerCase()) ||
    cert.cert?.toLowerCase().includes(search.toLowerCase())
  );

  const getCertificateName = (certId) => {
    return certificates.find((c) => c.id === certId)?.id.substring(0, 8) || 'Unknown';
  };

  return (
    <div>
      {/* Success/Error Messages */}
      {success && (
        <div className="mb-6 bg-green-900/20 border border-green-500 text-green-400 px-4 py-3 rounded">
          {success}
          <button onClick={() => setSuccess(null)} className="float-right font-bold">×</button>
        </div>
      )}
      {error && (
        <div className="mb-6 bg-red-900/20 border border-red-500 text-red-400 px-4 py-3 rounded">
          {error}
          <button onClick={() => setError(null)} className="float-right font-bold">×</button>
        </div>
      )}

      {/* Header */}
      <div className="mb-6 flex justify-between items-center gap-4">
        <div className="flex-1">
          <input
            type="text"
            placeholder="Search certificates..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              loadData();
            }}
            className="w-full px-4 py-2 bg-navy-900 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
          />
        </div>
        <button
          onClick={() => {
            resetForm();
            setShowCreateModal(true);
          }}
          className="flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-lg font-semibold transition-colors"
        >
          <Plus size={20} />
          Upload Certificate
        </button>
        <button
          onClick={() => setShowSNIModal(true)}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition-colors"
        >
          <Plus size={20} />
          Add SNI
        </button>
      </div>

      {/* Certificates Section */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-sky-400 mb-4">SSL/TLS Certificates</h2>
        {loading ? (
          <div className="text-center py-12 text-gray-400">Loading certificates...</div>
        ) : filteredCertificates.length === 0 ? (
          <div className="text-center py-12 text-gray-400">No certificates found</div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {filteredCertificates.map((cert) => {
              const warning = getExpirationWarning(cert);
              return (
                <div key={cert.id} className="bg-navy-900 border border-navy-700 rounded-lg p-6">
                  <div className="flex justify-between items-start mb-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="text-lg font-semibold text-sky-400">Certificate</h3>
                        {warning && (
                          <div className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${
                            warning.status === 'expired'
                              ? 'bg-red-900/30 text-red-400'
                              : 'bg-yellow-900/30 text-yellow-400'
                          }`}>
                            <AlertTriangle size={14} />
                            {warning.status === 'expired' ? 'Expired' : `Expires in ${warning.days} days`}
                          </div>
                        )}
                      </div>
                      <p className="text-gray-400 text-xs font-mono break-all">{cert.id}</p>
                    </div>
                    <button
                      onClick={() => handleDeleteCertificate(cert.id)}
                      className="p-2 hover:bg-red-900/50 rounded-lg transition-colors text-red-400"
                      title="Delete"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <span className="text-gray-500 text-sm">Subject</span>
                      <p className="text-white text-sm break-words">{cert.cert_alt_names?.[0] || 'N/A'}</p>
                    </div>
                    <div>
                      <span className="text-gray-500 text-sm">Alt Names</span>
                      <p className="text-white text-sm">{cert.cert_alt_names?.length || 0} domains</p>
                    </div>
                  </div>
                  {cert.cert_alt_names && cert.cert_alt_names.length > 0 && (
                    <div className="mb-4 p-3 bg-navy-800 rounded border border-navy-700">
                      <p className="text-xs text-gray-500 mb-2">Subject Alternative Names:</p>
                      <div className="flex flex-wrap gap-2">
                        {cert.cert_alt_names.map((name, idx) => (
                          <span key={idx} className="bg-navy-700 px-2 py-1 rounded text-xs text-sky-400">
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="text-xs text-gray-500">
                    Created: {new Date(cert.created_at).toLocaleDateString()}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SNIs Section */}
      <div>
        <h2 className="text-2xl font-bold text-sky-400 mb-4">Server Name Indication (SNI)</h2>
        {snis.length === 0 ? (
          <div className="text-center py-12 text-gray-400 bg-navy-900 border border-navy-700 rounded-lg">No SNIs configured</div>
        ) : (
          <div className="bg-navy-900 border border-navy-700 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-navy-800 border-b border-navy-700">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Domain</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-400 uppercase">Certificate</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-400 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-navy-700">
                {snis.map((sni) => (
                  <tr key={sni.id} className="hover:bg-navy-800/50">
                    <td className="px-6 py-4">
                      <div className="text-white font-semibold">{sni.name}</div>
                      <div className="text-xs text-gray-500 font-mono">{sni.id}</div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <code className="text-xs text-sky-400 bg-navy-800 px-2 py-1 rounded max-w-xs truncate">
                          {sni.certificate_id}
                        </code>
                        <button
                          onClick={() => copyToClipboard(sni.certificate_id)}
                          className="p-1 hover:bg-navy-800 rounded transition-colors text-gray-400"
                          title="Copy ID"
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <button
                        onClick={() => handleDeleteSNI(sni.id)}
                        className="p-2 hover:bg-red-900/50 rounded-lg transition-colors text-red-400"
                        title="Delete"
                      >
                        <Trash2 size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Certificate Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 border border-navy-700 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold text-sky-400 mb-6">Upload SSL/TLS Certificate</h2>
            <form onSubmit={handleCreateCertificate}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Certificate (PEM) *</label>
                  <textarea
                    value={formData.cert}
                    onChange={(e) => setFormData({ ...formData, cert: e.target.value })}
                    placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white font-mono focus:outline-none focus:border-sky-500"
                    rows={8}
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Private Key (PEM) *</label>
                  <textarea
                    value={formData.key}
                    onChange={(e) => setFormData({ ...formData, key: e.target.value })}
                    placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white font-mono focus:outline-none focus:border-sky-500"
                    rows={8}
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Tags (comma-separated, optional)</label>
                  <input
                    type="text"
                    value={formData.tags}
                    onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                    placeholder="prod,important"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateModal(false);
                    resetForm();
                  }}
                  className="px-4 py-2 bg-navy-800 hover:bg-navy-700 text-white rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-lg font-semibold transition-colors"
                >
                  Upload Certificate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add SNI Modal */}
      {showSNIModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-navy-900 border border-navy-700 rounded-lg p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-2xl font-bold text-sky-400 mb-6">Add Server Name Indication</h2>
            <form onSubmit={handleCreateSNI}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Domain Name *</label>
                  <input
                    type="text"
                    value={sniFormData.name}
                    onChange={(e) => setSNIFormData({ ...sniFormData, name: e.target.value })}
                    placeholder="e.g., api.example.com"
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-400 mb-1">Certificate *</label>
                  <select
                    value={sniFormData.certificate_id}
                    onChange={(e) => setSNIFormData({ ...sniFormData, certificate_id: e.target.value })}
                    className="w-full px-4 py-2 bg-navy-800 border border-navy-700 rounded-lg text-white focus:outline-none focus:border-sky-500"
                    required
                  >
                    <option value="">Select a certificate</option>
                    {certificates.map((cert) => (
                      <option key={cert.id} value={cert.id}>
                        {getCertificateName(cert.id)} ({cert.cert_alt_names?.[0] || 'Unknown'})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setShowSNIModal(false);
                    setSNIFormData({ name: '', certificate_id: '' });
                  }}
                  className="px-4 py-2 bg-navy-800 hover:bg-navy-700 text-white rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white rounded-lg font-semibold transition-colors"
                >
                  Add SNI
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
