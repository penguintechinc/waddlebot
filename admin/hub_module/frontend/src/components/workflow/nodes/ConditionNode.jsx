import { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/solid';

const ConditionNode = memo(({ data, selected }) => {
  return (
    <div
      className={`px-4 py-3 rounded-lg border-2 bg-navy-800 min-w-[200px] ${
        selected ? 'border-gold-400 shadow-lg shadow-gold-500/30' : 'border-yellow-500'
      }`}
    >
      <div className="flex items-center space-x-2 mb-2">
        <div className="w-6 h-6 rounded bg-yellow-500 flex items-center justify-center">
          <QuestionMarkCircleIcon className="w-4 h-4 text-navy-900" />
        </div>
        <div className="text-xs font-semibold text-yellow-400 uppercase">Condition</div>
      </div>

      <div className="text-sm font-medium text-white mb-1">{data.label}</div>

      {data.config && (
        <div className="text-xs text-navy-300 space-y-0.5">
          {data.config.conditionType && (
            <div>Type: {data.config.conditionType}</div>
          )}
          {data.config.operator && (
            <div>Operator: {data.config.operator}</div>
          )}
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        className="w-3 h-3 !bg-yellow-500 border-2 border-navy-800"
      />

      <Handle
        type="source"
        position={Position.Right}
        id="true"
        style={{ top: '35%' }}
        className="w-3 h-3 !bg-green-500 border-2 border-navy-800"
      />

      <Handle
        type="source"
        position={Position.Right}
        id="false"
        style={{ top: '65%' }}
        className="w-3 h-3 !bg-red-500 border-2 border-navy-800"
      />

      <div className="absolute -right-14 top-[calc(35%-8px)] text-[10px] text-green-400 font-semibold">
        TRUE
      </div>
      <div className="absolute -right-14 top-[calc(65%-8px)] text-[10px] text-red-400 font-semibold">
        FALSE
      </div>
    </div>
  );
});

ConditionNode.displayName = 'ConditionNode';

export default ConditionNode;
