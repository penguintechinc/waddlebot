import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { ArrowPathIcon } from '@heroicons/react/24/solid';

const LoopNode = memo(({ data, selected }) => {
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-navy-800 min-w-[200px] ${
        selected ? 'border-gold-400 shadow-lg shadow-gold-500/30' : 'border-orange-500'
      }`}
    >
      <div className="flex items-center space-x-2 mb-2">
        <div className="w-6 h-6 rounded bg-orange-500 flex items-center justify-center">
          <ArrowPathIcon className="w-4 h-4 text-white" />
        </div>
        <div className="text-xs font-semibold text-orange-400 uppercase">Loop</div>
      </div>

      <div className="text-sm font-medium text-white mb-1">{data.label}</div>

      {data.config && (
        <div className="text-xs text-navy-300 space-y-0.5">
          {data.config.loopType && (
            <div>Type: {data.config.loopType}</div>
          )}
          {data.config.maxIterations && (
            <div>Max: {data.config.maxIterations}</div>
          )}
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 !bg-orange-500 border-2 border-navy-800"
      />

      <Handle
        type="source"
        position={Position.Right}
        id="iteration"
        style={{ top: '40%' }}
        className="w-3 h-3 !bg-orange-500 border-2 border-navy-800"
      />

      <Handle
        type="source"
        position={Position.Right}
        id="complete"
        style={{ top: '70%' }}
        className="w-3 h-3 !bg-green-500 border-2 border-navy-800"
      />

      <div className="absolute -right-20 top-[calc(40%-8px)] text-[10px] text-orange-400 font-semibold">
        ITERATE
      </div>
      <div className="absolute -right-20 top-[calc(70%-8px)] text-[10px] text-green-400 font-semibold">
        COMPLETE
      </div>
    </div>
  );
});

LoopNode.displayName = 'LoopNode';

export default LoopNode;
