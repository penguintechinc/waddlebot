import {
  ArrowUturnLeftIcon,
  ArrowUturnRightIcon,
  TrashIcon,
  PlayIcon,
  BeakerIcon,
  CloudArrowUpIcon,
  DocumentCheckIcon,
} from '@heroicons/react/24/outline';

function WorkflowToolbar({
  workflowName,
  workflowStatus,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onClear,
  onSave,
  onTest,
  onPublish,
  onValidate,
  isSaving,
  isTesting,
  isPublishing,
}) {
  return (
    <div className="h-14 bg-navy-900 border-b border-navy-700 flex items-center justify-between px-4">
      {/* Left side - Workflow info */}
      <div className="flex items-center space-x-4">
        <div>
          <h3 className="text-sm font-semibold text-white">{workflowName}</h3>
          <div className="flex items-center space-x-2">
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                workflowStatus === 'published'
                  ? 'bg-green-500/20 text-green-400'
                  : workflowStatus === 'draft'
                    ? 'bg-yellow-500/20 text-yellow-400'
                    : 'bg-navy-700 text-navy-400'
              }`}
            >
              {workflowStatus}
            </span>
          </div>
        </div>
      </div>

      {/* Center - Edit controls */}
      <div className="flex items-center space-x-2">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="p-2 rounded-lg hover:bg-navy-800 text-navy-400 hover:text-sky-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Undo"
        >
          <ArrowUturnLeftIcon className="w-5 h-5" />
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="p-2 rounded-lg hover:bg-navy-800 text-navy-400 hover:text-sky-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          title="Redo"
        >
          <ArrowUturnRightIcon className="w-5 h-5" />
        </button>

        <div className="w-px h-6 bg-navy-700 mx-1"></div>

        <button
          onClick={onClear}
          className="p-2 rounded-lg hover:bg-navy-800 text-navy-400 hover:text-red-400 transition-colors"
          title="Clear Canvas"
        >
          <TrashIcon className="w-5 h-5" />
        </button>

        <button
          onClick={onValidate}
          className="p-2 rounded-lg hover:bg-navy-800 text-navy-400 hover:text-cyan-400 transition-colors"
          title="Validate Workflow"
        >
          <DocumentCheckIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Right side - Action buttons */}
      <div className="flex items-center space-x-2">
        <button
          onClick={onTest}
          disabled={isTesting}
          className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-navy-800 hover:bg-navy-700 text-sky-300 hover:text-sky-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <BeakerIcon className="w-4 h-4" />
          <span className="text-sm font-medium">
            {isTesting ? 'Testing...' : 'Test'}
          </span>
        </button>

        <button
          onClick={onSave}
          disabled={isSaving}
          className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <CloudArrowUpIcon className="w-4 h-4" />
          <span className="text-sm font-medium">
            {isSaving ? 'Saving...' : 'Save'}
          </span>
        </button>

        <button
          onClick={onPublish}
          disabled={isPublishing || workflowStatus === 'published'}
          className="flex items-center space-x-2 px-3 py-2 rounded-lg bg-gold-500 hover:bg-gold-600 text-navy-900 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <PlayIcon className="w-4 h-4" />
          <span className="text-sm">
            {isPublishing ? 'Publishing...' : 'Publish'}
          </span>
        </button>
      </div>
    </div>
  );
}

export default WorkflowToolbar;
