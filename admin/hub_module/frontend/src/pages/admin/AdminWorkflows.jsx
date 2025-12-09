import { useState, useCallback, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  MiniMap,
  MarkerType,
} from 'reactflow';
import 'reactflow/dist/style.css';

import TriggerNode from '../../components/workflow/nodes/TriggerNode';
import ConditionNode from '../../components/workflow/nodes/ConditionNode';
import ActionNode from '../../components/workflow/nodes/ActionNode';
import DataNode from '../../components/workflow/nodes/DataNode';
import LoopNode from '../../components/workflow/nodes/LoopNode';
import FlowNode from '../../components/workflow/nodes/FlowNode';

import WorkflowSidebar from '../../components/workflow/WorkflowSidebar';
import WorkflowToolbar from '../../components/workflow/WorkflowToolbar';
import WorkflowNodePalette from '../../components/workflow/WorkflowNodePalette';
import WorkflowPropertiesPanel from '../../components/workflow/WorkflowPropertiesPanel';
import WorkflowTestPanel from '../../components/workflow/WorkflowTestPanel';

const nodeTypes = {
  trigger: TriggerNode,
  condition: ConditionNode,
  action: ActionNode,
  data: DataNode,
  loop: LoopNode,
  flow: FlowNode,
};

const defaultEdgeOptions = {
  type: 'smoothstep',
  animated: false,
  markerEnd: {
    type: MarkerType.ArrowClosed,
  },
};

function WorkflowCanvas() {
  const { communityId } = useParams();
  const reactFlowWrapper = useRef(null);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);

  // Mock workflows data
  const [workflows, setWorkflows] = useState([
    {
      id: 'wf1',
      name: 'Welcome New Members',
      description: 'Send welcome message to new community members',
      status: 'published',
      triggerCount: 1,
    },
    {
      id: 'wf2',
      name: 'Auto Moderation',
      description: 'Automatic content moderation workflow',
      status: 'draft',
      triggerCount: 2,
    },
  ]);

  const [activeWorkflowId, setActiveWorkflowId] = useState('wf1');
  const [activeWorkflow, setActiveWorkflow] = useState(workflows[0]);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  const [selectedNode, setSelectedNode] = useState(null);
  const [showPropertiesPanel, setShowPropertiesPanel] = useState(false);
  const [showTestPanel, setShowTestPanel] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  // History for undo/redo
  const [history, setHistory] = useState([]);
  const [historyStep, setHistoryStep] = useState(0);

  // Handle node selection
  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node);
    setShowPropertiesPanel(true);
  }, []);

  // Handle connection
  const onConnect = useCallback(
    (params) => {
      setEdges((eds) => addEdge({ ...params, ...defaultEdgeOptions }, eds));
    },
    [setEdges]
  );

  // Handle drag over
  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  // Handle drop
  const onDrop = useCallback(
    (event) => {
      event.preventDefault();

      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const type = event.dataTransfer.getData('application/reactflow');

      if (!type) return;

      const nodeData = JSON.parse(type);
      const position = reactFlowInstance.project({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });

      const newNode = {
        id: `node-${Date.now()}`,
        type: nodeData.type,
        position,
        data: {
          label: nodeData.label,
          config: {},
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, setNodes]
  );

  // Update node data
  const onUpdateNode = useCallback(
    (nodeId, newData) => {
      setNodes((nds) =>
        nds.map((node) => {
          if (node.id === nodeId) {
            return {
              ...node,
              data: newData,
            };
          }
          return node;
        })
      );
    },
    [setNodes]
  );

  // Workflow sidebar actions
  const handleSelectWorkflow = useCallback(
    (workflowId) => {
      const workflow = workflows.find((w) => w.id === workflowId);
      if (workflow) {
        setActiveWorkflowId(workflowId);
        setActiveWorkflow(workflow);
        // Load workflow nodes and edges
        // TODO: Load from API
      }
    },
    [workflows]
  );

  const handleCreateWorkflow = useCallback(() => {
    const newWorkflow = {
      id: `wf${Date.now()}`,
      name: 'New Workflow',
      description: '',
      status: 'draft',
      triggerCount: 0,
    };
    setWorkflows((wfs) => [...wfs, newWorkflow]);
    setActiveWorkflowId(newWorkflow.id);
    setActiveWorkflow(newWorkflow);
    setNodes([]);
    setEdges([]);
  }, [setNodes, setEdges]);

  const handleDeleteWorkflow = useCallback(
    (workflowId) => {
      if (confirm('Are you sure you want to delete this workflow?')) {
        setWorkflows((wfs) => wfs.filter((w) => w.id !== workflowId));
        if (activeWorkflowId === workflowId) {
          const remainingWorkflows = workflows.filter((w) => w.id !== workflowId);
          if (remainingWorkflows.length > 0) {
            handleSelectWorkflow(remainingWorkflows[0].id);
          }
        }
      }
    },
    [activeWorkflowId, workflows, handleSelectWorkflow]
  );

  // Toolbar actions
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    // TODO: Save to API
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setIsSaving(false);
    alert('Workflow saved successfully!');
  }, []);

  const handleTest = useCallback(() => {
    setIsTesting(true);
    setShowTestPanel(true);
    setShowPropertiesPanel(false);
  }, []);

  const handlePublish = useCallback(async () => {
    setIsPublishing(true);
    // TODO: Publish via API
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setActiveWorkflow((wf) => ({ ...wf, status: 'published' }));
    setWorkflows((wfs) =>
      wfs.map((w) => (w.id === activeWorkflowId ? { ...w, status: 'published' } : w))
    );
    setIsPublishing(false);
    alert('Workflow published successfully!');
  }, [activeWorkflowId]);

  const handleValidate = useCallback(() => {
    // TODO: Validate workflow
    const triggerNodes = nodes.filter((n) => n.type === 'trigger');
    if (triggerNodes.length === 0) {
      alert('Workflow must have at least one trigger node');
      return;
    }
    alert('Workflow is valid!');
  }, [nodes]);

  const handleClear = useCallback(() => {
    if (confirm('Are you sure you want to clear the canvas?')) {
      setNodes([]);
      setEdges([]);
    }
  }, [setNodes, setEdges]);

  const handleUndo = useCallback(() => {
    // TODO: Implement undo
  }, []);

  const handleRedo = useCallback(() => {
    // TODO: Implement redo
  }, []);

  // Test panel actions
  const handleHighlightNode = useCallback(
    (nodeId) => {
      setNodes((nds) =>
        nds.map((node) => ({
          ...node,
          style: {
            ...node.style,
            boxShadow: node.id === nodeId ? '0 0 20px rgba(234, 179, 8, 0.8)' : undefined,
          },
        }))
      );

      // Clear highlight after delay
      setTimeout(() => {
        setNodes((nds) =>
          nds.map((node) => ({
            ...node,
            style: {
              ...node.style,
              boxShadow: undefined,
            },
          }))
        );
      }, 1000);
    },
    [setNodes]
  );

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Workflow List Sidebar */}
      <WorkflowSidebar
        workflows={workflows}
        activeWorkflowId={activeWorkflowId}
        onSelectWorkflow={handleSelectWorkflow}
        onCreateWorkflow={handleCreateWorkflow}
        onDeleteWorkflow={handleDeleteWorkflow}
      />

      {/* Main Canvas Area */}
      <div className="flex-1 flex flex-col">
        {/* Toolbar */}
        <WorkflowToolbar
          workflowName={activeWorkflow?.name || 'Workflow'}
          workflowStatus={activeWorkflow?.status || 'draft'}
          canUndo={historyStep > 0}
          canRedo={historyStep < history.length - 1}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClear={handleClear}
          onSave={handleSave}
          onTest={handleTest}
          onPublish={handlePublish}
          onValidate={handleValidate}
          isSaving={isSaving}
          isTesting={isTesting}
          isPublishing={isPublishing}
        />

        {/* React Flow Canvas */}
        <div className="flex-1 bg-navy-950" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onInit={setReactFlowInstance}
            onDrop={onDrop}
            onDragOver={onDragOver}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            fitView
            attributionPosition="bottom-left"
          >
            <Background color="#1e293b" gap={16} />
            <Controls className="bg-navy-800 border-navy-700" />
            <MiniMap
              className="bg-navy-800 border-navy-700"
              nodeColor={(node) => {
                switch (node.type) {
                  case 'trigger':
                    return '#a855f7';
                  case 'condition':
                    return '#eab308';
                  case 'action':
                    return '#3b82f6';
                  case 'data':
                    return '#06b6d4';
                  case 'loop':
                    return '#f97316';
                  case 'flow':
                    return '#ec4899';
                  default:
                    return '#64748b';
                }
              }}
            />
          </ReactFlow>
        </div>
      </div>

      {/* Node Palette */}
      <WorkflowNodePalette />

      {/* Properties Panel */}
      {showPropertiesPanel && (
        <WorkflowPropertiesPanel
          selectedNode={selectedNode}
          onUpdateNode={onUpdateNode}
          onClose={() => setShowPropertiesPanel(false)}
        />
      )}

      {/* Test Panel */}
      {showTestPanel && (
        <WorkflowTestPanel
          workflowId={activeWorkflowId}
          onClose={() => {
            setShowTestPanel(false);
            setIsTesting(false);
          }}
          onHighlightNode={handleHighlightNode}
        />
      )}
    </div>
  );
}

function AdminWorkflows() {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas />
    </ReactFlowProvider>
  );
}

export default AdminWorkflows;
