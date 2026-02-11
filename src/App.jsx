import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MapContainer, Marker, TileLayer, Popup, Circle, useMapEvents, useMap } from 'react-leaflet';
import L from 'leaflet';
import { supabase } from './lib/supabase.js';

const DEFAULT_ROUTE = {
  id: 'route-1',
  name: 'Select a Route',
  center: { lat: 37.7749, lng: -122.4194 },
  radiusM: 800
};

const INITIAL_PIECES = [];
const DEVICE_ID_KEY = 'geoPuzzle:device-id';
const LAST_ROUTE_KEY = 'geoPuzzle:last-route-id';

const userIcon = new L.DivIcon({
  className: 'user-dot',
  iconSize: [18, 18]
});

const pieceIcon = new L.DivIcon({
  className: 'piece-dot',
  iconSize: [18, 18]
});

const SHAPE_CLASSES = ['shape-a', 'shape-b', 'shape-c', 'shape-d'];

const hashString = (value) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

const makeThumbIcon = (url, shapeClass) =>
  new L.DivIcon({
    className: 'piece-thumb-icon',
    html: `<div class="piece-thumb-marker ${shapeClass}" style="background-image:url('${url}')"></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function MapClickHandler({ enabled, onClick, onAdd }) {
  useMapEvents({
    click(e) {
      if (!enabled) return;
      const point = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (onClick) onClick(point);
      if (onAdd) onAdd(point);
    }
  });
  return null;
}

function MapCenterUpdater({ center, zoom = 16 }) {
  const map = useMap();
  useEffect(() => {
    if (!center) return;
    map.setView([center.lat, center.lng], zoom, { animate: true });
  }, [center?.lat, center?.lng, zoom, map]);
  return null;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value || ''
  );
}

export default function App() {
  const [mode, setMode] = useState('walk');
  const [route, setRoute] = useState(DEFAULT_ROUTE);
  const [pieces, setPieces] = useState(INITIAL_PIECES);
  const [collectedIds, setCollectedIds] = useState([]);
  const [userPos, setUserPos] = useState(null);
  const [collectionRadius, setCollectionRadius] = useState(30);
  const [exportText, setExportText] = useState('');
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [deleteMode, setDeleteMode] = useState(false);
  const [lastClick, setLastClick] = useState(null);
  const watchIdRef = useRef(null);
  const [routesList, setRoutesList] = useState([]);
  const [selectedRouteId, setSelectedRouteId] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authUser, setAuthUser] = useState(null);
  const [adminError, setAdminError] = useState('');
  const [walkError, setWalkError] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [puzzleImageUrl, setPuzzleImageUrl] = useState('');
  const [gridCols, setGridCols] = useState(3);
  const [gridRows, setGridRows] = useState(3);
  const [deviceId, setDeviceId] = useState('');
  const [walkBusy, setWalkBusy] = useState(false);
  const lastSliceRef = useRef('');

  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const user = data.session?.user ?? null;
      setAuthUser(user);
      setAdminUnlocked(Boolean(user));
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setAuthUser(user);
      setAdminUnlocked(Boolean(user));
    });
    return () => {
      mounted = false;
      listener?.subscription?.unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      setDeviceId(existing);
      return;
    }
    const nextId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, nextId);
    setDeviceId(nextId);
  }, []);

  const collectedSet = useMemo(() => new Set(collectedIds), [collectedIds]);
  const orderedPieces = useMemo(
    () => [...pieces].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    [pieces]
  );
  const thumbIcons = useMemo(() => {
    const map = new Map();
    orderedPieces.forEach((piece) => {
      if (piece.imageFragmentUrl) {
        const shapeIndex = hashString(piece.id ?? String(piece.order)) % SHAPE_CLASSES.length;
        const shapeClass = SHAPE_CLASSES[shapeIndex];
        map.set(piece.id, makeThumbIcon(piece.imageFragmentUrl, shapeClass));
      }
    });
    return map;
  }, [orderedPieces]);
  const remaining = orderedPieces.filter((p) => !collectedSet.has(p.id));

  const allCollected = pieces.length > 0 && collectedIds.length === pieces.length;

  const startWalk = () => {
    if (!selectedRouteId) {
      alert('Select a route first.');
      return;
    }
    if (!navigator.geolocation) {
      alert('Geolocation is not supported on this device.');
      return;
    }
    if (watchIdRef.current !== null) return;
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const nextPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserPos(nextPos);
        const newlyCollected = remaining
          .filter((piece) => haversineMeters(nextPos, piece) <= collectionRadius)
          .map((piece) => piece.id);
        if (newlyCollected.length) {
          setCollectedIds((prev) => [...new Set([...prev, ...newlyCollected])]);
        }
      },
      (err) => {
        console.error(err);
        alert('Unable to read location. Make sure location access is enabled.');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000
      }
    );
  };

  const stopWalk = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  };

  const addPiece = (point) => {
    setPieces((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        lat: point.lat,
        lng: point.lng,
        order: prev.length + 1,
        imageFragmentUrl: ''
      }
    ]);
  };

  const removePiece = (pieceId) => {
    setPieces((prev) => prev.filter((piece) => piece.id !== pieceId));
    setCollectedIds((prev) => prev.filter((id) => id !== pieceId));
  };

  const loadImage = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Failed to read image.'));
      reader.readAsDataURL(file);
    });

  const sliceImage = (dataUrl, cols, rows) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const piecesOut = [];
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const tileW = Math.floor(img.width / cols);
        const tileH = Math.floor(img.height / rows);
        canvas.width = tileW;
        canvas.height = tileH;
        let order = 1;
        for (let r = 0; r < rows; r += 1) {
          for (let c = 0; c < cols; c += 1) {
            ctx.clearRect(0, 0, tileW, tileH);
            ctx.drawImage(
              img,
              c * tileW,
              r * tileH,
              tileW,
              tileH,
              0,
              0,
              tileW,
              tileH
            );
            const fragment = canvas.toDataURL('image/png');
            piecesOut.push({ order, fragment });
            order += 1;
          }
        }
        resolve(piecesOut);
      };
      img.onerror = () => reject(new Error('Failed to load image.'));
      img.src = dataUrl;
    });

  const computeGrid = (count) => {
    const safeCount = Math.max(1, count);
    const cols = Math.ceil(Math.sqrt(safeCount));
    const rows = Math.ceil(safeCount / cols);
    return { cols, rows };
  };

  const applyImageFragments = (fragments) => {
    setPieces((prev) => {
      if (!prev.length) return prev;
      return prev.map((piece, idx) => ({
        ...piece,
        imageFragmentUrl: fragments[idx]?.fragment ?? ''
      }));
    });
  };

  useEffect(() => {
    if (!puzzleImageUrl || !pieces.length) return;
    const { cols, rows } = computeGrid(pieces.length);
    const sliceKey = `${puzzleImageUrl.length}:${pieces.length}:${cols}x${rows}`;
    if (lastSliceRef.current === sliceKey) return;
    lastSliceRef.current = sliceKey;
    setGridCols(cols);
    setGridRows(rows);
    sliceImage(puzzleImageUrl, cols, rows)
      .then(applyImageFragments)
      .catch((err) => alert(err.message));
  }, [puzzleImageUrl, pieces.length]);

  const resliceFromPieceCount = async () => {
    if (!puzzleImageUrl || !pieces.length) return;
    try {
      const { cols, rows } = computeGrid(pieces.length);
      setGridCols(cols);
      setGridRows(rows);
      const fragments = await sliceImage(puzzleImageUrl, cols, rows);
      applyImageFragments(fragments);
    } catch (err) {
      alert(err.message);
    }
  };

  const handlePuzzleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await loadImage(file);
      setPuzzleImageUrl(dataUrl);
      const { cols, rows } = computeGrid(pieces.length);
      setGridCols(cols);
      setGridRows(rows);
      const fragments = await sliceImage(dataUrl, cols, rows);
      applyImageFragments(fragments);
    } catch (err) {
      alert(err.message);
    }
  };

  const exportRoute = () => {
    const payload = { route, pieces, puzzleImageUrl, gridCols, gridRows };
    setExportText(JSON.stringify(payload, null, 2));
  };

  const importRoute = () => {
    try {
      const parsed = JSON.parse(exportText);
      if (parsed.route && parsed.pieces) {
        setRoute(parsed.route);
        setPieces(parsed.pieces);
        setPuzzleImageUrl(parsed.puzzleImageUrl ?? '');
        setGridCols(parsed.gridCols ?? 3);
        setGridRows(parsed.gridRows ?? 3);
        setCollectedIds([]);
      }
    } catch (err) {
      alert('Invalid JSON');
    }
  };

  const saveProgress = async (nextCollectedIds) => {
    if (!deviceId || !isUuid(route.id) || route.id !== selectedRouteId) return;
    const validIds = nextCollectedIds.filter((id) => isUuid(id));
    const now = new Date().toISOString();
    const completedAt =
      pieces.length > 0 && validIds.length === pieces.length ? now : null;
    const { error } = await supabase.from('progress').upsert(
      {
        route_id: route.id,
        device_id: deviceId,
        collected_piece_ids: validIds,
        completed_at: completedAt,
        updated_at: now
      },
      { onConflict: 'route_id,device_id' }
    );
    if (error) {
      setWalkError(error.message);
    }
  };

  const resetProgress = async () => {
    setCollectedIds([]);
    await saveProgress([]);
  };

  const signInAdmin = async (event) => {
    event.preventDefault();
    setAdminBusy(true);
    setAdminError('');
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail.trim(),
      password: authPassword
    });
    if (error) {
      setAdminError(error.message);
    }
    setAdminBusy(false);
  };

  const signOutAdmin = async () => {
    setAdminBusy(true);
    await supabase.auth.signOut();
    setAdminBusy(false);
  };

  const loadRoutesList = async () => {
    const { data, error } = await supabase
      .from('routes')
      .select('id, name, created_at')
      .order('created_at', { ascending: false });
    if (error) {
      setWalkError(error.message);
      setAdminError(error.message);
      return;
    }
    setRoutesList(data ?? []);
  };

  const loadProgress = async (routeId, pieceIds) => {
    if (!routeId || !deviceId || !isUuid(routeId)) return;
    const { data, error } = await supabase
      .from('progress')
      .select('collected_piece_ids')
      .eq('route_id', routeId)
      .eq('device_id', deviceId)
      .maybeSingle();
    if (error) {
      setWalkError(error.message);
      setAdminError(error.message);
      return;
    }
    const validSet = new Set(pieceIds);
    const nextCollected = (data?.collected_piece_ids ?? []).filter((id) => validSet.has(id));
    setCollectedIds(nextCollected);
  };

  const loadRoute = async (routeId) => {
    if (!routeId) return;
    setWalkBusy(true);
    setWalkError('');
    const { data: routeData, error: routeError } = await supabase
      .from('routes')
      .select('*')
      .eq('id', routeId)
      .single();
    if (routeError) {
      setWalkError(routeError.message);
      setAdminError(routeError.message);
      setWalkBusy(false);
      return;
    }
    const { data: pieceData, error: pieceError } = await supabase
      .from('pieces')
      .select('*')
      .eq('route_id', routeId)
      .order('piece_order', { ascending: true });
    if (pieceError) {
      setWalkError(pieceError.message);
      setAdminError(pieceError.message);
      setWalkBusy(false);
      return;
    }
    const hasFragments = (pieceData ?? []).some((piece) => piece.image_fragment_url);
    const normalizedPieces = (pieceData ?? []).map((piece) => ({
      id: piece.id,
      lat: piece.lat,
      lng: piece.lng,
      order: piece.piece_order,
      imageFragmentUrl: piece.image_fragment_url ?? ''
    }));
    setRoute({
      id: routeData.id,
      name: routeData.name,
      center: { lat: routeData.center_lat, lng: routeData.center_lng },
      radiusM: routeData.radius_m
    });
    setPuzzleImageUrl(routeData.puzzle_image_url ?? '');
    setGridCols(routeData.grid_cols ?? 3);
    setGridRows(routeData.grid_rows ?? 3);
    setPieces(normalizedPieces);
    if (!hasFragments && routeData.puzzle_image_url) {
      try {
        const { cols, rows } = computeGrid(pieceData?.length ?? 1);
        const fragments = await sliceImage(routeData.puzzle_image_url, cols, rows);
        applyImageFragments(fragments);
      } catch (err) {
        setWalkError(err.message);
        setAdminError(err.message);
      }
    }
    await loadProgress(routeId, normalizedPieces.map((piece) => piece.id));
    setSelectedRouteId(routeId);
    localStorage.setItem(LAST_ROUTE_KEY, routeId);
    setWalkBusy(false);
    // Map recenters via MapCenterUpdater when route center changes.
  };

  useEffect(() => {
    if (!deviceId) return;
    let active = true;
    const bootstrapWalkMode = async () => {
      await loadRoutesList();
      const lastRouteId = localStorage.getItem(LAST_ROUTE_KEY);
      if (active && lastRouteId && isUuid(lastRouteId)) {
        await loadRoute(lastRouteId);
      }
    };
    bootstrapWalkMode();
    return () => {
      active = false;
    };
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId || !isUuid(route.id) || route.id !== selectedRouteId) return;
    saveProgress(collectedIds);
  }, [collectedIds, deviceId, route.id, selectedRouteId, pieces.length]);

  const saveRoute = async () => {
    if (!adminUnlocked) {
      setAdminError('Sign in to save routes.');
      return;
    }
    setAdminBusy(true);
    setAdminError('');
    const routeId = route.id || crypto.randomUUID();
    const { error: routeError } = await supabase.from('routes').upsert(
      {
        id: routeId,
        name: route.name,
        center_lat: route.center.lat,
        center_lng: route.center.lng,
        radius_m: route.radiusM,
        created_by: authUser?.email ?? 'admin',
        puzzle_image_url: puzzleImageUrl || null,
        grid_cols: gridCols,
        grid_rows: gridRows
      },
      { onConflict: 'id' }
    );
    if (routeError) {
      setAdminError(routeError.message);
      setAdminBusy(false);
      return;
    }
    await supabase.from('pieces').delete().eq('route_id', routeId);
    if (pieces.length) {
      const { error: pieceError } = await supabase.from('pieces').insert(
        pieces.map((piece, index) => ({
          route_id: routeId,
          lat: piece.lat,
          lng: piece.lng,
          piece_order: index + 1,
          image_fragment_url: piece.imageFragmentUrl ?? null
        }))
      );
      if (pieceError) {
        setAdminError(pieceError.message);
      }
    }
    setRoute((prev) => ({ ...prev, id: routeId }));
    await loadRoutesList();
    setSelectedRouteId(routeId);
    setAdminBusy(false);
  };

  const newRoute = () => {
    setRoute({
      id: crypto.randomUUID(),
      name: 'New Route',
      center: { ...route.center },
      radiusM: route.radiusM
    });
    setPieces([]);
    setCollectedIds([]);
    setPuzzleImageUrl('');
    setSelectedRouteId('');
  };

  const setCenterFromLastClick = () => {
    if (!lastClick) return;
    setRoute((prev) => ({
      ...prev,
      center: { lat: lastClick.lat, lng: lastClick.lng }
    }));
  };

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>GeoPuzzle Walks</h1>
          <p>{route.name}</p>
        </div>
        <div className="mode-toggle">
          <button
            className={mode === 'walk' ? 'active' : ''}
            onClick={() => setMode('walk')}
          >
            Walk Mode
          </button>
          <button
            className={mode === 'admin' ? 'active' : ''}
            onClick={() => setMode('admin')}
          >
            Admin Mode
          </button>
        </div>
      </header>

      <section className="status-row">
        <div className="status-card">
          <span>Collected</span>
          <strong>
            {collectedIds.length} / {pieces.length}
          </strong>
        </div>
        <div className="status-card">
          <span>Auto-Collect Radius</span>
          <strong>{collectionRadius} m</strong>
        </div>
        <div className="status-card">
          <span>Privacy</span>
          <strong>No location logs</strong>
        </div>
      </section>

      <main className="map-shell">
        <MapContainer
          center={[route.center.lat, route.center.lng]}
          zoom={16}
          scrollWheelZoom
        >
          <MapCenterUpdater center={route.center} />
          <TileLayer
            attribution='&copy; OpenStreetMap contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Circle
            center={[route.center.lat, route.center.lng]}
            radius={route.radiusM}
            pathOptions={{ color: '#f1c27d', fillOpacity: 0.08 }}
          />
          <MapClickHandler
            enabled={mode === 'admin' && adminUnlocked}
            onClick={setLastClick}
            onAdd={deleteMode ? null : addPiece}
          />
          {orderedPieces.map((piece) => (
            <Marker
              key={piece.id}
              position={[piece.lat, piece.lng]}
              icon={thumbIcons.get(piece.id) ?? pieceIcon}
              eventHandlers={{
                click: () => {
                  if (mode === 'admin' && adminUnlocked && deleteMode) {
                    removePiece(piece.id);
                  }
                }
              }}
            >
              <Popup>
                <strong>Piece {piece.order}</strong>
                <div>{piece.id}</div>
                {mode === 'admin' && adminUnlocked && (
                  <button
                    className="popup-delete"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removePiece(piece.id);
                    }}
                  >
                    Remove Piece
                  </button>
                )}
              </Popup>
            </Marker>
          ))}
          {userPos && (
            <Marker position={[userPos.lat, userPos.lng]} icon={userIcon}>
              <Popup>You</Popup>
            </Marker>
          )}
        </MapContainer>
      </main>

      <section className="controls">
        {mode === 'walk' ? (
          <div className="control-group">
            <label>
              Route
              <select
                value={selectedRouteId}
                onChange={(e) => loadRoute(e.target.value)}
                disabled={walkBusy}
              >
                <option value="">Select a route</option>
                {routesList.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-actions">
              <button type="button" onClick={loadRoutesList} className="ghost">
                Refresh Routes
              </button>
              {walkBusy && <span>Loading route...</span>}
            </div>
            <button onClick={startWalk}>Start Walk</button>
            <button onClick={stopWalk} className="ghost">
              Stop
            </button>
            <button onClick={resetProgress} className="ghost">
              Reset Progress
            </button>
            {walkError && <small>{walkError}</small>}
            <label>
              Radius (m)
              <input
                type="number"
                min={10}
                max={100}
                value={collectionRadius}
                onChange={(e) => setCollectionRadius(Number(e.target.value))}
              />
            </label>
            {orderedPieces.some((p) => p.imageFragmentUrl) && (
              <div
                className="puzzle-grid"
                style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)` }}
              >
                {orderedPieces.map((piece) => (
                  <div key={piece.id} className="puzzle-cell">
                    {collectedSet.has(piece.id) && piece.imageFragmentUrl ? (
                      <img
                        src={piece.imageFragmentUrl}
                        alt={`Piece ${piece.order}`}
                      />
                    ) : (
                      <span>?</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            {allCollected && (
              <div className="puzzle-reveal">
                <h2>Puzzle Complete</h2>
                <p>All pieces collected. Time to reveal the full image.</p>
                {puzzleImageUrl ? (
                  <img className="puzzle-full" src={puzzleImageUrl} alt="Puzzle" />
                ) : (
                  <div className="puzzle-placeholder">Full Puzzle Preview</div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="control-group">
            {!adminUnlocked ? (
              <form onSubmit={signInAdmin} className="admin-lock">
                <p>Admin sign in</p>
                <label>
                  Email
                  <input
                    type="email"
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="you@example.com"
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="Password"
                    required
                  />
                </label>
                <button type="submit">Unlock Admin</button>
                {adminError && <small>{adminError}</small>}
              </form>
            ) : (
              <>
                <p>Tap the map to place pieces.</p>
                <div className="inline-actions">
                  <button
                    type="button"
                    onClick={loadRoutesList}
                    className="ghost"
                    disabled={adminBusy}
                  >
                    Refresh Routes
                  </button>
                  <button type="button" onClick={newRoute} className="ghost">
                    New Route
                  </button>
                  <button type="button" onClick={saveRoute} disabled={adminBusy}>
                    {adminBusy ? 'Saving…' : 'Save Route'}
                  </button>
                  <button type="button" className="ghost" onClick={signOutAdmin}>
                    Sign Out
                  </button>
                </div>
                <label>
                  Load Route
                  <select
                    value={selectedRouteId}
                    onChange={(e) => loadRoute(e.target.value)}
                  >
                    <option value="">Select a route</option>
                    {routesList.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="latlng-readout">
                  <span>
                    Last tap:{' '}
                    {lastClick
                      ? `${lastClick.lat.toFixed(6)}, ${lastClick.lng.toFixed(6)}`
                      : '—'}
                  </span>
                  <button
                    type="button"
                    className="ghost"
                    onClick={setCenterFromLastClick}
                    disabled={!lastClick}
                  >
                    Set Center From Tap
                  </button>
                </div>
                <div className="inline-actions">
                  <button
                    type="button"
                    className={deleteMode ? 'danger' : 'ghost'}
                    onClick={() => setDeleteMode((prev) => !prev)}
                  >
                    {deleteMode ? 'Delete Mode: On' : 'Delete Mode: Off'}
                  </button>
                </div>
                <label>
                  Route Name
                  <input
                    type="text"
                    value={route.name}
                    onChange={(e) => setRoute({ ...route, name: e.target.value })}
                  />
                </label>
                <label>
                  Center Lat
                  <input
                    type="number"
                    value={route.center.lat}
                    onChange={(e) =>
                      setRoute({
                        ...route,
                        center: { ...route.center, lat: Number(e.target.value) }
                      })
                    }
                  />
                </label>
                <label>
                  Center Lng
                  <input
                    type="number"
                    value={route.center.lng}
                    onChange={(e) =>
                      setRoute({
                        ...route,
                        center: { ...route.center, lng: Number(e.target.value) }
                      })
                    }
                  />
                </label>
                <label>
                  Route Radius (m)
                  <input
                    type="number"
                    value={route.radiusM}
                    onChange={(e) =>
                      setRoute({ ...route, radiusM: Number(e.target.value) })
                    }
                  />
                </label>
                <div className="puzzle-admin">
                  <p>Puzzle Image</p>
                  <div className="inline-actions">
                    <span>
                      Grid: {gridCols} x {gridRows}
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      onClick={resliceFromPieceCount}
                      disabled={!puzzleImageUrl || !pieces.length}
                    >
                      Reslice From Pieces
                    </button>
                  </div>
                  <input type="file" accept="image/*" onChange={handlePuzzleUpload} />
                  {pieces.length !== gridCols * gridRows && (
                    <small>
                      Pieces count ({pieces.length}) does not match grid size (
                      {gridCols * gridRows}). Add/remove pieces or reslice.
                    </small>
                  )}
                  {puzzleImageUrl && (
                    <img className="puzzle-thumb" src={puzzleImageUrl} alt="Puzzle" />
                  )}
                </div>
                <div className="inline-actions">
                  <button onClick={exportRoute}>Export JSON</button>
                  <button onClick={importRoute} className="ghost">
                    Import JSON
                  </button>
                </div>
                <textarea
                  rows={8}
                  value={exportText}
                  onChange={(e) => setExportText(e.target.value)}
                  placeholder="Exported route JSON will appear here"
                />
              </>
            )}
          </div>
        )}
      </section>

      <footer className="footer">
        <span>Pieces remaining: {remaining.length}</span>
        <span>Mode: {mode}</span>
      </footer>
    </div>
  );
}
