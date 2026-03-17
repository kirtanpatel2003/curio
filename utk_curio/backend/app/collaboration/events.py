from flask import request
from flask_socketio import join_room, leave_room, emit
from utk_curio.backend.extensions import socketio

# {room: {nodeId: {userId, color}}}
_locked_nodes: dict = {}

# {room: {userId: {color, sid}}}
_room_users: dict = {}

# {room: {nodes: {id: node}, edges: {id: edge}}}  — live graph state
_room_graph: dict = {}

# {room: {nodeId: output_value}}  — execution outputs per node
_room_outputs: dict = {}

_COLORS = [
    '#e74c3c', '#3498db', '#2ecc71', '#f39c12',
    '#9b59b6', '#1abc9c', '#e67e22', '#16a085',
]


def _assign_color(room: str, user_id: str) -> str:
    users = _room_users.get(room, {})
    keys = list(users.keys())
    if user_id in keys:
        return users[user_id]['color']
    return _COLORS[len(keys) % len(_COLORS)]


def _cleanup_user(room: str, user_id: str) -> None:
    """Remove user from room state and release their node locks."""
    if room in _room_users and user_id in _room_users[room]:
        del _room_users[room][user_id]

    if room in _locked_nodes:
        unlocked = [
            nid for nid, info in _locked_nodes[room].items()
            if info.get('userId') == user_id
        ]
        for nid in unlocked:
            del _locked_nodes[room][nid]
            emit('node_unlocked', {'nodeId': nid}, to=room)

    emit('user_left', {'userId': user_id}, to=room)


# ── Session lifecycle ────────────────────────────────────────────────────────

@socketio.on('join_session')
def on_join(data):
    room = data.get('sessionId', 'default')
    user_id = data.get('userId')
    color = _assign_color(room, user_id)

    join_room(room)

    _room_users.setdefault(room, {})[user_id] = {
        'color': color,
        'sid': request.sid,
    }
    _locked_nodes.setdefault(room, {})
    graph = _room_graph.setdefault(room, {'nodes': {}, 'edges': {}})

    # Send full current state to the joining client
    emit('session_state', {
        'color': color,
        'lockedNodes': _locked_nodes[room],
        'connectedUsers': [
            {'userId': uid, 'color': info['color']}
            for uid, info in _room_users[room].items()
            if uid != user_id
        ],
        'nodes': list(graph['nodes'].values()),
        'edges': list(graph['edges'].values()),
        'outputs': _room_outputs.get(room, {}),
    })

    # Tell everyone else a new user arrived
    emit('user_joined', {'userId': user_id, 'color': color}, to=room, include_self=False)


@socketio.on('leave_session')
def on_leave(data):
    room = data.get('sessionId', 'default')
    user_id = data.get('userId')
    leave_room(room)
    _cleanup_user(room, user_id)


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for room, users in list(_room_users.items()):
        for user_id, info in list(users.items()):
            if info.get('sid') == sid:
                _cleanup_user(room, user_id)
                return


# ── Graph change events (store + relay to room, skip sender) ─────────────────

@socketio.on('node_added')
def on_node_added(data):
    room = data.get('sessionId', 'default')
    node = data.get('node', {})
    if node.get('id'):
        _room_graph.setdefault(room, {'nodes': {}, 'edges': {}})['nodes'][node['id']] = node
    emit('node_added', data, to=room, include_self=False)


@socketio.on('node_updated')
def on_node_updated(data):
    """Sync node data changes (e.g. execution output, code edits)."""
    room = data.get('sessionId', 'default')
    node = data.get('node', {})
    if node.get('id') and room in _room_graph:
        _room_graph[room]['nodes'][node['id']] = node
    emit('node_updated', data, to=room, include_self=False)


@socketio.on('node_removed')
def on_node_removed(data):
    room = data.get('sessionId', 'default')
    node_id = data.get('nodeId')
    if node_id and room in _room_graph:
        _room_graph[room]['nodes'].pop(node_id, None)
    if node_id:
        _room_outputs.get(room, {}).pop(node_id, None)
    emit('node_removed', data, to=room, include_self=False)


@socketio.on('edge_added')
def on_edge_added(data):
    room = data.get('sessionId', 'default')
    edge = data.get('edge', {})
    if edge.get('id'):
        _room_graph.setdefault(room, {'nodes': {}, 'edges': {}})['edges'][edge['id']] = edge
    emit('edge_added', data, to=room, include_self=False)


@socketio.on('edge_removed')
def on_edge_removed(data):
    room = data.get('sessionId', 'default')
    edge_id = data.get('edgeId')
    if edge_id and room in _room_graph:
        _room_graph[room]['edges'].pop(edge_id, None)
    emit('edge_removed', data, to=room, include_self=False)


# ── Output sync ──────────────────────────────────────────────────────────────

@socketio.on('output_produced')
def on_output_produced(data):
    """Sync execution outputs so all browsers can propagate data on new connections."""
    room = data.get('sessionId', 'default')
    node_id = data.get('nodeId')
    output = data.get('output')
    if node_id:
        _room_outputs.setdefault(room, {})[node_id] = output
    emit('output_produced', data, to=room, include_self=False)


# ── Node lock / conflict detection ──────────────────────────────────────────

@socketio.on('node_lock')
def on_node_lock(data):
    room = data.get('sessionId', 'default')
    node_id = data.get('nodeId')
    user_id = data.get('userId')
    color = _room_users.get(room, {}).get(user_id, {}).get('color', '#3498db')

    locks = _locked_nodes.setdefault(room, {})
    existing = locks.get(node_id)

    if existing and existing['userId'] != user_id:
        # Two users on the same node → conflict
        emit('conflict_detected', {
            'nodeId': node_id,
            'lockedBy': existing,
            'requestedBy': {'userId': user_id, 'color': color},
        }, to=room)
        return

    locks[node_id] = {'userId': user_id, 'color': color}
    emit('node_locked', {'nodeId': node_id, 'userId': user_id, 'color': color},
         to=room, include_self=False)


@socketio.on('node_unlock')
def on_node_unlock(data):
    room = data.get('sessionId', 'default')
    node_id = data.get('nodeId')
    user_id = data.get('userId')

    locks = _locked_nodes.get(room, {})
    if locks.get(node_id, {}).get('userId') == user_id:
        del locks[node_id]
        emit('node_unlocked', {'nodeId': node_id}, to=room, include_self=False)
