import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { ArrowsRightLeftIcon } from '@heroicons/react/24/solid';

const FlowNode = memo(({ data, selected }) => {
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-navy-800 min-w-[200px] ${
        selected ? 'border-gold-400 shadow-lg shadow-gold-500/30' : 'border-pink-500'
      }`}
    >
      <div className="flex items-center space-x-2 mb-2">
        <div className="w-6 h-6 rounded bg-pink-500 flex items-center justify-center">
          <ArrowsRightLeftIcon className="w-4 h-4 text-white" />
        </div>
        <div className="text-xs font-semibold text-pink-400 uppercase">Flow Control</div>
      </div>

      <div className="text-sm font-medium text-white mb-1">{data.label}</div>

      {data.config && (
        <div className="text-xs text-navy-300 space-y-0.5">
          {data.config.flowType && (
            <div>Type: {data.config.flowType}</div>
          )}
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 !bg-pink-500 border-2 border-navy-800"
      />

      <Handle
        type="source"
        position={Position.Right}
        className="w-3 h-3 !bg-pink-500 border-2 border-navy-800"
      />
    </div>
  );
});

FlowNode.displayName = 'FlowNode';

export default FlowNode;
