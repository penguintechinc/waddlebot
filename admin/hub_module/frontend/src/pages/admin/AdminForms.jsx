import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
  DocumentTextIcon,
  PlusIcon,
  TrashIcon,
  EyeIcon,
  ArrowDownTrayIcon,
} from '@heroicons/react/24/outline';
import { adminApi } from '../../services/api';

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Text Area' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: 'Number' },
  { value: 'select', label: 'Dropdown' },
  { value: 'radio', label: 'Radio Buttons' },
  { value: 'checkbox', label: 'Checkboxes' },
  { value: 'date', label: 'Date' },
];

function AdminForms() {
  const { communityId } = useParams();
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedForm, setSelectedForm] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [newForm, setNewForm] = useState({
    title: '',
    description: '',
    fields: [{ type: 'text', label: '', placeholder: '', required: false, options: [] }],
    view_visibility: 'community',
    submit_visibility: 'community',
    allow_anonymous: false,
    submit_once_per_user: true,
  });

  useEffect(() => {
    loadForms();
  }, [communityId]);

  const loadForms = async () => {
    try {
      setLoading(true);
      const response = await adminApi.getForms(communityId);
      setForms(response.data?.forms || []);
    } catch (err) {
      setError('Failed to load forms');
    } finally {
      setLoading(false);
    }
  };

  const createForm = async () => {
    try {
      const validFields = newForm.fields.filter(f => f.label.trim());
      if (validFields.length === 0) {
        setError('At least 1 field required');
        return;
      }
      await adminApi.createForm(communityId, {
        ...newForm,
        fields: validFields,
      });
      setMessage({ type: 'success', text: 'Form created' });
      setShowCreateModal(false);
      setNewForm({
        title: '',
        description: '',
        fields: [{ type: 'text', label: '', placeholder: '', required: false, options: [] }],
        view_visibility: 'community',
        submit_visibility: 'community',
        allow_anonymous: false,
        submit_once_per_user: true,
      });
      loadForms();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create form');
    }
  };

  const deleteForm = async (formId) => {
    if (!window.confirm('Delete this form and all submissions?')) return;
    try {
      await adminApi.deleteForm(communityId, formId);
      setMessage({ type: 'success', text: 'Form deleted' });
      loadForms();
      if (selectedForm?.id === formId) setSelectedForm(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete form');
    }
  };

  const loadFormSubmissions = async (formId) => {
    try {
      const [formRes, subsRes] = await Promise.all([
        adminApi.getForm(communityId, formId),
        adminApi.getFormSubmissions(communityId, formId),
      ]);
      setSelectedForm(formRes.data?.form);
      setSubmissions(subsRes.data?.submissions || []);
    } catch (err) {
      setError('Failed to load form details');
    }
  };

  const addField = () => {
    setNewForm({
      ...newForm,
      fields: [...newForm.fields, { type: 'text', label: '', placeholder: '', required: false, options: [] }],
    });
  };

  const removeField = (index) => {
    if (newForm.fields.length <= 1) return;
    setNewForm({
      ...newForm,
      fields: newForm.fields.filter((_, i) => i !== index),
    });
  };

  const updateField = (index, updates) => {
    const fields = [...newForm.fields];
    fields[index] = { ...fields[index], ...updates };
    setNewForm({ ...newForm, fields });
  };

  const exportSubmissions = () => {
    if (!selectedForm || submissions.length === 0) return;
    const headers = ['Submitted At', 'User ID', ...selectedForm.fields.map(f => f.label)];
    const rows = submissions.map(sub => [
      sub.submitted_at,
      sub.user_id || 'Anonymous',
      ...selectedForm.fields.map(f => sub.values[f.id] || ''),
    ]);
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedForm.title}-submissions.csv`;
    a.click();
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-sky-500"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <DocumentTextIcon className="h-8 w-8 text-sky-500" />
          Community Forms
        </h1>
        <button onClick={() => setShowCreateModal(true)} className="btn btn-primary">
          <PlusIcon className="h-5 w-5 mr-2" />
          Create Form
        </button>
      </div>

      {error && (
        <div className="bg-red-500/20 border border-red-500 text-red-300 px-4 py-3 rounded">
          {error}
          <button onClick={() => setError(null)} className="float-right">&times;</button>
        </div>
      )}

      {message && (
        <div className={`px-4 py-3 rounded ${message.type === 'success' ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
          {message.text}
          <button onClick={() => setMessage(null)} className="float-right">&times;</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form List */}
        <div className="space-y-4">
          {forms.length === 0 ? (
            <div className="card p-8 text-center">
              <DocumentTextIcon className="h-16 w-16 text-gray-500 mx-auto mb-4" />
              <p className="text-gray-400">No forms yet. Create your first form!</p>
            </div>
          ) : (
            forms.map((form) => (
              <div
                key={form.id}
                className={`card p-4 cursor-pointer hover:ring-2 hover:ring-sky-500 transition ${
                  selectedForm?.id === form.id ? 'ring-2 ring-sky-500' : ''
                }`}
                onClick={() => loadFormSubmissions(form.id)}
              >
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-white font-medium">{form.title}</h3>
                    {form.description && (
                      <p className="text-gray-400 text-sm mt-1 line-clamp-2">{form.description}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 text-xs text-gray-500">
                      <span className="flex items-center gap-1">
                        <EyeIcon className="h-3 w-3" />
                        {form.view_visibility}
                      </span>
                      <span>{form.fields?.length || 0} fields</span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteForm(form.id); }}
                    className="btn btn-sm btn-danger"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Submissions */}
        <div className="card p-6">
          {selectedForm ? (
            <>
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-lg font-semibold text-white">{selectedForm.title}</h2>
                <button onClick={exportSubmissions} className="btn btn-sm btn-secondary">
                  <ArrowDownTrayIcon className="h-4 w-4 mr-1" />
                  Export CSV
                </button>
              </div>
              <p className="text-gray-500 text-sm mb-4">
                {submissions.length} submission{submissions.length !== 1 ? 's' : ''}
              </p>
              {submissions.length === 0 ? (
                <p className="text-gray-400 text-center py-8">No submissions yet</p>
              ) : (
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {submissions.map((sub) => (
                    <div key={sub.id} className="p-3 bg-gray-800 rounded">
                      <div className="flex justify-between text-xs text-gray-500 mb-2">
                        <span>{sub.user_id || 'Anonymous'}</span>
                        <span>{new Date(sub.submitted_at).toLocaleString()}</span>
                      </div>
                      {selectedForm.fields?.map((field) => (
                        <div key={field.id} className="text-sm mb-1">
                          <span className="text-gray-400">{field.label}:</span>
                          <span className="text-white ml-2">
                            {JSON.stringify(sub.values[field.id]) || '-'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-gray-400 text-center py-8">Select a form to view submissions</p>
          )}
        </div>
      </div>

      {/* Create Form Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-y-auto py-8">
          <div className="card p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-lg font-semibold text-white mb-4">Create Form</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Title</label>
                <input
                  type="text"
                  value={newForm.title}
                  onChange={(e) => setNewForm({ ...newForm, title: e.target.value })}
                  placeholder="Feedback Form"
                  className="input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">Description (optional)</label>
                <textarea
                  value={newForm.description}
                  onChange={(e) => setNewForm({ ...newForm, description: e.target.value })}
                  placeholder="Tell us what you think..."
                  className="input w-full h-20"
                />
              </div>

              {/* Fields Builder */}
              <div>
                <label className="block text-sm text-gray-400 mb-2">Fields</label>
                {newForm.fields.map((field, i) => (
                  <div key={i} className="p-3 bg-gray-800 rounded mb-2">
                    <div className="grid grid-cols-2 gap-2 mb-2">
                      <select
                        value={field.type}
                        onChange={(e) => updateField(i, { type: e.target.value })}
                        className="input"
                      >
                        {FIELD_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={field.label}
                        onChange={(e) => updateField(i, { label: e.target.value })}
                        placeholder="Field label"
                        className="input"
                      />
                    </div>
                    <div className="flex items-center gap-4">
                      <input
                        type="text"
                        value={field.placeholder || ''}
                        onChange={(e) => updateField(i, { placeholder: e.target.value })}
                        placeholder="Placeholder"
                        className="input flex-1"
                      />
                      <label className="flex items-center gap-1 text-sm text-gray-300">
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={(e) => updateField(i, { required: e.target.checked })}
                          className="rounded"
                        />
                        Required
                      </label>
                      {newForm.fields.length > 1 && (
                        <button onClick={() => removeField(i)} className="btn btn-sm btn-danger">
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <button onClick={addField} className="btn btn-sm btn-secondary">
                  <PlusIcon className="h-4 w-4 mr-1" />
                  Add Field
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Who can view</label>
                  <select
                    value={newForm.view_visibility}
                    onChange={(e) => setNewForm({ ...newForm, view_visibility: e.target.value })}
                    className="input w-full"
                  >
                    <option value="public">Public</option>
                    <option value="registered">Registered Users</option>
                    <option value="community">Community Members</option>
                    <option value="admins">Admins Only</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Who can submit</label>
                  <select
                    value={newForm.submit_visibility}
                    onChange={(e) => setNewForm({ ...newForm, submit_visibility: e.target.value })}
                    className="input w-full"
                  >
                    <option value="public">Public</option>
                    <option value="registered">Registered Users</option>
                    <option value="community">Community Members</option>
                    <option value="admins">Admins Only</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="checkbox"
                    checked={newForm.allow_anonymous}
                    onChange={(e) => setNewForm({ ...newForm, allow_anonymous: e.target.checked })}
                    className="rounded"
                  />
                  Allow anonymous submissions
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-300">
                  <input
                    type="checkbox"
                    checked={newForm.submit_once_per_user}
                    onChange={(e) => setNewForm({ ...newForm, submit_once_per_user: e.target.checked })}
                    className="rounded"
                  />
                  One submission per user
                </label>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button onClick={() => setShowCreateModal(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={createForm} className="btn btn-primary">Create Form</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminForms;
