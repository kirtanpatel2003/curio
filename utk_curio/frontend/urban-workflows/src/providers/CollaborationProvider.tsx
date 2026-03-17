import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { io, Socket } from 'socket.io-client';
import { v4 as uuidv4 } from 'uuid';
import { useFlowContext } from './FlowProvider';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CollabUser {
  userId: string;
  color: string;
}

export interface LockInfo {
  userId: string;
  color: string;
}

export interface Conflict {
  nodeId: string;
  lockedBy: LockInfo;
  requestedBy: LockInfo;
  timestamp: number;
}

interface CollaborationContextProps {
  isConnected: boolean;
  myUserId: string;
  myColor: string;
  sessionId: string;
  connectedUsers: CollabUser[];
  lockedNodes: Record<string, LockInfo>;
  conflicts: Conflict[];
  lockNode: (nodeId: string) => void;
  unlockNode: (nodeId: string) => void;
  dismissConflict: (nodeId: string) => void;
}

const CollaborationContext = createContext<CollaborationContextProps>({
  isConnected: false,
  myUserId: '',
  myColor: '#3498db',
  sessionId: 'default',
  connectedUsers: [],
  lockedNodes: {},
  conflicts: [],
  lockNode: () => {},
  unlockNode: () => {},
  dismissConflict: () => {},
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const BACKEND_URL =
  (window as any).__CURIO_BACKEND_URL__ ||
  `http://${window.location.hostname}:5002`;

// Fields in node.data that are class instances or functions — never sync them.
const SKIP_DATA_FIELDS = new Set(['pythonInterpreter']);

/**
 * Strip non-serializable fields from a node before sending over the socket.
 * Returns a plain-JSON-safe copy.
 */
function serializeNode(node: any): any {
  const data: Record<string, any> = {};
  for (const [k, v] of Object.entries(node.data || {})) {
    if (SKIP_DATA_FIELDS.has(k)) continue;
    // Also skip functions and class instances (keep only plain values)
    if (typeof v === 'function') continue;
    if (v !== null && typeof v === 'object' && typeof (v as any).interpretCode === 'function') continue;
    data[k] = v;
  }
  return { ...node, data };
}

/** Lightweight fingerprint of the node data fields that matter for collaboration. */
function dataFingerprint(node: any): string {
  const d = node.data || {};
  return JSON.stringify({
    input: d.input,
    source: d.source,
    defaultCode: d.defaultCode,
    content: d.content,
    code: d.code,
    outputCode: d.output?.code,
    outputContent: d.output?.content,
  });
}

function getOrCreateUserId(): string {
  const key = 'curio_collab_userId';
  let id = localStorage.getItem(key);
  if (!id) {
    id = uuidv4();
    localStorage.setItem(key, id);
  }
  return id;
}

// ── Provider ─────────────────────────────────────────────────────────────────

const CollaborationProvider = ({ children }: { children: ReactNode }) => {
  const { nodes, edges, setNodes, setEdges, outputs, setOutputs, workflowNameRef } = useFlowContext();

  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const myUserId = useRef(getOrCreateUserId()).current;
  const [myColor, setMyColor] = useState('#3498db');

  const [connectedUsers, setConnectedUsers] = useState<CollabUser[]>([]);
  const [lockedNodes, setLockedNodes] = useState<Record<string, LockInfo>>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);

  // Track previous node/edge id-sets to diff local changes
  const prevNodeIds = useRef<Set<string>>(new Set());
  const prevEdgeIds = useRef<Set<string>>(new Set());

  // Track node data fingerprints to detect content changes
  const prevNodeData = useRef<Map<string, string>>(new Map());

  // Ids added/removed/updated by remote events — skip re-emitting them
  const remoteNodeAdds = useRef<Set<string>>(new Set());
  const remoteNodeRemoves = useRef<Set<string>>(new Set());
  const remoteNodeUpdates = useRef<Set<string>>(new Set());
  const remoteEdgeAdds = useRef<Set<string>>(new Set());
  const remoteEdgeRemoves = useRef<Set<string>>(new Set());
  const remoteOutputUpdates = useRef<Set<string>>(new Set());

  // Keep refs so socket handlers can read the latest values
  const outputsRef = useRef(outputs);
  useEffect(() => { outputsRef.current = outputs; }, [outputs]);
  const edgesRef = useRef(edges);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  // Track previous output fingerprints to detect local changes
  const prevOutputFingerprints = useRef<Map<string, string>>(new Map());

  const sessionId = workflowNameRef.current || 'default';

  // ── Socket setup ────────────────────────────────────────────────────────

  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
      socket.emit('join_session', { sessionId, userId: myUserId });
    });

    socket.on('disconnect', () => setIsConnected(false));

    socket.on('session_state', (data: any) => {
      setMyColor(data.color);
      setLockedNodes(data.lockedNodes || {});
      setConnectedUsers(data.connectedUsers || []);

      // Populate outputs[] from server-synced outputs
      const remoteOutputs: Record<string, any> = data.outputs || {};
      if (Object.keys(remoteOutputs).length > 0) {
        const entries = Object.entries(remoteOutputs).map(([nodeId, output]) => ({ nodeId, output }));
        entries.forEach((e) => remoteOutputUpdates.current.add(e.nodeId));
        setOutputs((prev: any[]) => {
          const existingIds = new Set(prev.map((o: any) => o.nodeId));
          const newEntries = entries.filter((e) => !existingIds.has(e.nodeId));
          return [...prev, ...newEntries];
        });
      }

      // Apply existing graph so late joiners see the full canvas
      const remoteNodes: any[] = data.nodes || [];
      const remoteEdges: any[] = data.edges || [];

      if (remoteNodes.length > 0) {
        remoteNodes.forEach((n) => remoteNodeAdds.current.add(n.id));
        setNodes((prev: any[]) => {
          const existingIds = new Set(prev.map((n) => n.id));
          const safeNodes = remoteNodes
            .filter((n) => !existingIds.has(n.id))
            .map((n) => {
              const safeData = { ...n.data };
              SKIP_DATA_FIELDS.forEach((f) => delete safeData[f]);
              return { ...n, data: safeData };
            });
          return [...prev, ...safeNodes];
        });
      }
      if (remoteEdges.length > 0) {
        remoteEdges.forEach((e) => remoteEdgeAdds.current.add(e.id));
        setEdges((prev: any[]) => {
          const existingIds = new Set(prev.map((e) => e.id));
          return [...prev, ...remoteEdges.filter((e) => !existingIds.has(e.id))];
        });
      }
    });

    socket.on('user_joined', (data: CollabUser) => {
      setConnectedUsers((prev) => {
        if (prev.some((u) => u.userId === data.userId)) return prev;
        return [...prev, data];
      });
    });

    socket.on('user_left', (data: { userId: string }) => {
      setConnectedUsers((prev) => prev.filter((u) => u.userId !== data.userId));
    });

    // ── Remote graph changes ──────────────────────────────────────────────

    socket.on('node_added', (data: any) => {
      const node = data.node;
      remoteNodeAdds.current.add(node.id);
      setNodes((prev: any[]) => {
        if (prev.some((n) => n.id === node.id)) return prev;
        // Strip any corrupted class fields that lost their prototype during JSON transit
        const safeData = { ...node.data };
        SKIP_DATA_FIELDS.forEach((f) => delete safeData[f]);
        return [...prev, { ...node, data: safeData }];
      });
    });

    socket.on('node_removed', (data: { nodeId: string }) => {
      remoteNodeRemoves.current.add(data.nodeId);
      setNodes((prev: any[]) => prev.filter((n) => n.id !== data.nodeId));
    });

    socket.on('edge_added', (data: any) => {
      const edge = data.edge;
      remoteEdgeAdds.current.add(edge.id);
      setEdges((prev: any[]) => {
        if (prev.some((e) => e.id === edge.id)) return prev;
        return [...prev, edge];
      });

      // Propagate source node's output to the newly connected target node
      // using the synced outputs[] array as the source of truth
      if (edge.sourceHandle !== 'in/out' || edge.targetHandle !== 'in/out') {
        const srcOutput = outputsRef.current.find((o: any) => o.nodeId === edge.source);
        if (srcOutput) {
          setNodes((prev: any[]) => prev.map((n) => {
            if (n.id !== edge.target) return n;
            return { ...n, data: { ...n.data, input: srcOutput.output, source: edge.source } };
          }));
        }
      }
    });

    socket.on('edge_removed', (data: { edgeId: string }) => {
      remoteEdgeRemoves.current.add(data.edgeId);
      setEdges((prev: any[]) => prev.filter((e) => e.id !== data.edgeId));
    });

    socket.on('node_updated', (data: any) => {
      const node = data.node;
      remoteNodeUpdates.current.add(node.id);
      setNodes((prev: any[]) => prev.map((n) => {
        if (n.id !== node.id) return n;
        const remoteData = { ...node.data };
        SKIP_DATA_FIELDS.forEach((f) => delete remoteData[f]);
        return { ...n, data: { ...n.data, ...remoteData } };
      }));
    });

    // ── Output sync ─────────────────────────────────────────────────────

    socket.on('output_produced', (data: any) => {
      const { nodeId, output } = data;
      remoteOutputUpdates.current.add(nodeId);
      setOutputs((prev: any[]) => {
        const idx = prev.findIndex((o: any) => o.nodeId === nodeId);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = { nodeId, output };
          return updated;
        }
        return [...prev, { nodeId, output }];
      });

      // Propagate output to downstream connected nodes
      const downstream = edgesRef.current
        .filter((e: any) => e.source === nodeId && !(e.sourceHandle === 'in/out' && e.targetHandle === 'in/out'))
        .map((e: any) => e.target);
      if (downstream.length > 0) {
        setNodes((prev: any[]) => prev.map((n) => {
          if (!downstream.includes(n.id)) return n;
          return { ...n, data: { ...n.data, input: output, source: nodeId } };
        }));
      }
    });

    // ── Lock events ───────────────────────────────────────────────────────

    socket.on('node_locked', (data: { nodeId: string; userId: string; color: string }) => {
      setLockedNodes((prev) => ({
        ...prev,
        [data.nodeId]: { userId: data.userId, color: data.color },
      }));
    });

    socket.on('node_unlocked', (data: { nodeId: string }) => {
      setLockedNodes((prev) => {
        const next = { ...prev };
        delete next[data.nodeId];
        return next;
      });
    });

    socket.on('conflict_detected', (data: any) => {
      setConflicts((prev) => [...prev, { ...data, timestamp: Date.now() }]);
    });

    return () => {
      socket.emit('leave_session', { sessionId, userId: myUserId });
      socket.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Detect local node changes and emit ──────────────────────────────────

  useEffect(() => {
    const currentIds = new Set(nodes.map((n) => n.id));

    for (const node of nodes) {
      if (!prevNodeIds.current.has(node.id)) {
        // New node
        if (remoteNodeAdds.current.has(node.id)) {
          remoteNodeAdds.current.delete(node.id);
        } else {
          socketRef.current?.emit('node_added', { sessionId, userId: myUserId, node: serializeNode(node) });
        }
        // Seed data fingerprint for this new node
        prevNodeData.current.set(node.id, dataFingerprint(node));
      } else {
        // Existing node — check if data changed (execution output, code, etc.)
        const fp = dataFingerprint(node);
        const prevFp = prevNodeData.current.get(node.id);
        if (prevFp !== undefined && prevFp !== fp) {
          if (remoteNodeUpdates.current.has(node.id)) {
            remoteNodeUpdates.current.delete(node.id);
          } else {
            socketRef.current?.emit('node_updated', { sessionId, userId: myUserId, node: serializeNode(node) });
          }
          prevNodeData.current.set(node.id, fp);
        }
      }
    }

    for (const id of prevNodeIds.current) {
      if (!currentIds.has(id)) {
        prevNodeData.current.delete(id);
        if (remoteNodeRemoves.current.has(id)) {
          remoteNodeRemoves.current.delete(id);
        } else {
          socketRef.current?.emit('node_removed', { sessionId, userId: myUserId, nodeId: id });
        }
      }
    }

    prevNodeIds.current = currentIds;
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Detect local edge changes and emit ──────────────────────────────────

  useEffect(() => {
    const currentIds = new Set(edges.map((e) => e.id));

    for (const edge of edges) {
      if (!prevEdgeIds.current.has(edge.id)) {
        if (remoteEdgeAdds.current.has(edge.id)) {
          remoteEdgeAdds.current.delete(edge.id);
        } else {
          socketRef.current?.emit('edge_added', { sessionId, userId: myUserId, edge });
        }
      }
    }

    for (const id of prevEdgeIds.current) {
      if (!currentIds.has(id)) {
        if (remoteEdgeRemoves.current.has(id)) {
          remoteEdgeRemoves.current.delete(id);
        } else {
          socketRef.current?.emit('edge_removed', { sessionId, userId: myUserId, edgeId: id });
        }
      }
    }

    prevEdgeIds.current = currentIds;
  }, [edges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Detect local output changes and emit ────────────────────────────────

  useEffect(() => {
    for (const entry of outputs) {
      const fp = JSON.stringify(entry.output);
      const prevFp = prevOutputFingerprints.current.get(entry.nodeId);
      if (prevFp === fp) continue;
      prevOutputFingerprints.current.set(entry.nodeId, fp);

      if (remoteOutputUpdates.current.has(entry.nodeId)) {
        remoteOutputUpdates.current.delete(entry.nodeId);
      } else {
        socketRef.current?.emit('output_produced', { sessionId, userId: myUserId, nodeId: entry.nodeId, output: entry.output });
      }
    }
  }, [outputs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Lock API ────────────────────────────────────────────────────────────

  const lockNode = useCallback((nodeId: string) => {
    setLockedNodes((prev) => ({ ...prev, [nodeId]: { userId: myUserId, color: myColor } }));
    socketRef.current?.emit('node_lock', { sessionId, userId: myUserId, nodeId });
  }, [myUserId, myColor, sessionId]);

  const unlockNode = useCallback((nodeId: string) => {
    setLockedNodes((prev) => { const n = { ...prev }; delete n[nodeId]; return n; });
    socketRef.current?.emit('node_unlock', { sessionId, userId: myUserId, nodeId });
  }, [myUserId, sessionId]);

  const dismissConflict = useCallback((nodeId: string) => {
    setConflicts((prev) => prev.filter((c) => c.nodeId !== nodeId));
  }, []);

  return (
    <CollaborationContext.Provider value={{
      isConnected,
      myUserId,
      myColor,
      sessionId,
      connectedUsers,
      lockedNodes,
      conflicts,
      lockNode,
      unlockNode,
      dismissConflict,
    }}>
      {children}
    </CollaborationContext.Provider>
  );
};

export const useCollaborationContext = () => useContext(CollaborationContext);

export default CollaborationProvider;
