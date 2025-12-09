import { useState } from 'react';
import {
  BoltIcon,
  QuestionMarkCircleIcon,
  PlayIcon,
  CircleStackIcon,
  ArrowPathIcon,
  ArrowsRightLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/solid';

const nodeCategories = [
  {
    name: 'Triggers',
    icon: BoltIcon,
    color: 'purple',
    nodes: [
      { type: 'trigger', label: 'Chat Message', description: 'Trigger on chat message' },
      { type: 'trigger', label: 'Command', description: 'Trigger on specific command' },
      { type: 'trigger', label: 'Event', description: 'Trigger on platform event' },
      { type: 'trigger', label: 'Webhook', description: 'Trigger from webhook call' },
      { type: 'trigger', label: 'Schedule', description: 'Trigger on schedule' },
    ],
  },
  {
    name: 'Conditions',
    icon: QuestionMarkCircleIcon,
    color: 'yellow',
    nodes: [
      { type: 'condition', label: 'If/Else', description: 'Branch based on condition' },
      { type: 'condition', label: 'User Role', description: 'Check user role' },
      { type: 'condition', label: 'Permission', description: 'Check permission' },
      { type: 'condition', label: 'Text Match', description: 'Match text pattern' },
      { type: 'condition', label: 'Compare', description: 'Compare values' },
    ],
  },
  {
    name: 'Actions',
    icon: PlayIcon,
    color: 'blue',
    nodes: [
      { type: 'action', label: 'Send Message', description: 'Send chat message' },
      { type: 'action', label: 'Call Module', description: 'Call action module' },
      { type: 'action', label: 'HTTP Request', description: 'Make HTTP request' },
      { type: 'action', label: 'Delay', description: 'Wait for duration' },
      { type: 'action', label: 'Webhook', description: 'Send webhook' },
    ],
  },
  {
    name: 'Data',
    icon: CircleStackIcon,
    color: 'cyan',
    nodes: [
      { type: 'data', label: 'Get Variable', description: 'Get workflow variable' },
      { type: 'data', label: 'Set Variable', description: 'Set workflow variable' },
      { type: 'data', label: 'Database Query', description: 'Query database' },
      { type: 'data', label: 'Transform', description: 'Transform data' },
      { type: 'data', label: 'Parse JSON', description: 'Parse JSON data' },
    ],
  },
  {
    name: 'Loops',
    icon: ArrowPathIcon,
    color: 'orange',
    nodes: [
      { type: 'loop', label: 'For Each', description: 'Loop over items' },
      { type: 'loop', label: 'While', description: 'Loop while condition' },
      { type: 'loop', label: 'Repeat', description: 'Repeat N times' },
    ],
  },
  {
    name: 'Flow Control',
    icon: ArrowsRightLeftIcon,
    color: 'pink',
    nodes: [
      { type: 'flow', label: 'Merge', description: 'Merge multiple paths' },
      { type: 'flow', label: 'Split', description: 'Split into parallel paths' },
      { type: 'flow', label: 'Stop', description: 'Stop workflow execution' },
    ],
  },
];

function WorkflowNodePalette({ onDragStart }) {
  const [expandedCategories, setExpandedCategories] = useState(
    Object.fromEntries(nodeCategories.map((cat) => [cat.name, true]))
  );

  const toggleCategory = (categoryName) => {
    setExpandedCategories((prev) => ({
      ...prev,
      [categoryName]: !prev[categoryName],
    }));
  };

  const handleDragStart = (event, nodeType, label) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(
      'application/reactflow',
      JSON.stringify({ type: nodeType, label })
    );
    if (onDragStart) onDragStart(event, nodeType, label);
  };

  const getColorClasses = (color) => {
    const colors = {
      purple: 'bg-purple-500/20 text-purple-400 border-purple-500/30 hover:border-purple-400',
      yellow: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30 hover:border-yellow-400',
      blue: 'bg-blue-500/20 text-blue-400 border-blue-500/30 hover:border-blue-400',
      cyan: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30 hover:border-cyan-400',
      orange: 'bg-orange-500/20 text-orange-400 border-orange-500/30 hover:border-orange-400',
      pink: 'bg-pink-500/20 text-pink-400 border-pink-500/30 hover:border-pink-400',
    };
    return colors[color] || colors.blue;
  };

  return (
    <div className="w-64 bg-navy-900 border-l border-navy-700 overflow-y-auto">
      <div className="p-4 border-b border-navy-700">
        <h3 className="text-sm font-semibold text-white">Node Palette</h3>
        <p className="text-xs text-navy-400 mt-1">Drag nodes onto canvas</p>
      </div>

      <div className="p-2 space-y-2">
        {nodeCategories.map((category) => (
          <div key={category.name} className="border border-navy-700 rounded-lg overflow-hidden">
            <button
              onClick={() => toggleCategory(category.name)}
              className="w-full px-3 py-2 bg-navy-800 hover:bg-navy-750 flex items-center justify-between transition-colors"
            >
              <div className="flex items-center space-x-2">
                <category.icon className={`w-4 h-4 text-${category.color}-400`} />
                <span className="text-sm font-medium text-white">{category.name}</span>
              </div>
              {expandedCategories[category.name] ? (
                <ChevronDownIcon className="w-4 h-4 text-navy-400" />
              ) : (
                <ChevronRightIcon className="w-4 h-4 text-navy-400" />
              )}
            </button>

            {expandedCategories[category.name] && (
              <div className="p-2 space-y-1 bg-navy-850">
                {category.nodes.map((node, index) => (
                  <div
                    key={`${node.type}-${index}`}
                    draggable
                    onDragStart={(e) => handleDragStart(e, node.type, node.label)}
                    className={`px-3 py-2 rounded border cursor-move transition-all ${getColorClasses(
                      category.color
                    )}`}
                  >
                    <div className="text-xs font-medium">{node.label}</div>
                    <div className="text-[10px] opacity-75 mt-0.5">{node.description}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="p-4 border-t border-navy-700 bg-navy-850">
        <div className="text-xs text-navy-500">
          <div className="font-semibold mb-1">Tips:</div>
          <ul className="list-disc list-inside space-y-1">
            <li>Drag nodes to canvas</li>
            <li>Connect output to input</li>
            <li>Click node to configure</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default WorkflowNodePalette;
