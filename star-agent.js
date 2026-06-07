const StarAgent = (() => {
  // ─── State ───────────────────────────────────────────────────────────────────
  let _scene, _camera, _controls, _stars, _names;
  let _highlights = [];
  let _navigator = null; // set via setNavigator() — wraps index.html's recenter()
  let _activeStar = null; // SIMBAD id of the star currently in focus (set by click or navigate)
  const _conversationHistory = [];
  let _isThinking = false;
  const SESSION_KEY = "sa_api_key";

  // ─── Tool definitions ────────────────────────────────────────────────────────

  const TOOLS = [
    {
      name: "navigate_to_star",
      description:
        'Smoothly flies the camera to a star by name (SIMBAD ID or common name). Use when the user wants to "visit", "fly to", or "show" a specific star.',
      input_schema: {
        type: "object",
        properties: {
          star_name: {
            type: "string",
            description:
              'Star name: SIMBAD ID (e.g. "* alf CMa") or common name ("Sirius", "Vega", "Betelgeuse")',
          },
        },
        required: ["star_name"],
      },
    },
    {
      name: "get_nearby_stars",
      description:
        "Returns a list of stars within a given radius from the current camera position or from a specific star.",
      input_schema: {
        type: "object",
        properties: {
          radius_ly: {
            type: "number",
            description: "Search radius in light-years",
          },
          from_star: {
            type: "string",
            description:
              "Optional: search near this star instead of the camera position",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default 10)",
          },
        },
        required: ["radius_ly"],
      },
    },
    {
      name: "search_stars_by_type",
      description:
        "Finds stars by spectral class (O, B, A, F, G, K, M) or type (red giant, white dwarf, etc). Returns a list with distances.",
      input_schema: {
        type: "object",
        properties: {
          spectral_prefix: {
            type: "string",
            description:
              'Start of spectral class: "M", "K", "G", "A", "B", "O", "F", "WD" (white dwarf), "C" (carbon star)',
          },
          max_distance_ly: {
            type: "number",
            description: "Optional: only within this radius from the Sun",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default 10)",
          },
        },
        required: ["spectral_prefix"],
      },
    },
    {
      name: "highlight_stars",
      description:
        "Highlights a group of stars on the 3D scene with a glowing wireframe halo. Use to visually demonstrate search results.",
      input_schema: {
        type: "object",
        properties: {
          star_names: {
            type: "array",
            items: { type: "string" },
            description: "Array of SIMBAD IDs of stars to highlight",
          },
          color: {
            type: "string",
            description:
              'Color: "cyan", "orange", "green", "red", "yellow", "purple"',
          },
        },
        required: ["star_names", "color"],
      },
    },
    {
      name: "clear_highlights",
      description: "Removes all highlight halos from the scene.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_current_position",
      description:
        "Returns the current camera position and the nearest stars to it. Useful for orientation.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_star_details",
      description:
        "Gets technical data for a specific star from the dataset: coordinates, distance, spectral class, radius.",
      input_schema: {
        type: "object",
        properties: {
          star_name: {
            type: "string",
            description: "SIMBAD ID or common name of the star",
          },
        },
        required: ["star_name"],
      },
    },
    {
      name: "plan_tour",
      description:
        "Plans and launches an automatic tour — sequential camera flights to multiple stars with pauses.",
      input_schema: {
        type: "object",
        properties: {
          stops: {
            type: "array",
            items: { type: "string" },
            description: "Ordered list of SIMBAD IDs to visit",
          },
          pause_seconds: {
            type: "number",
            description: "Pause at each star in seconds (default 4)",
          },
        },
        required: ["stops"],
      },
    },
  ];

  // ─── Tool helper functions ───────────────────────────────────────────────────

  function findStar(name) {
    if (!name) return null;
    const n = name.toLowerCase().trim();
    // Exact match by SIMBAD ID
    let found = _stars.find((s) => s.name.toLowerCase() === n);
    if (found) return found;
    // Match by common name via the ghb names table
    const alias = _names.find((e) => e.name.toLowerCase() === n);
    if (alias) found = _stars.find((s) => s.name === alias.code);
    if (found) return found;
    // Partial match
    found = _stars.find(
      (s) =>
        s.name.toLowerCase().includes(n) ||
        (s.secondName && s.secondName.toLowerCase().includes(n)),
    );
    return found || null;
  }

  function starDistanceFromSun(star) {
    // Position stores coordinates in light-years (per tby/tko in index.html)
    return star.position ? star.position.length() : 0;
  }

  function getSpectralFromData(star) {
    if (!star.data) return "";
    const parts = star.data.split("|");
    return parts[4] || "";
  }

  function getRadiusFromData(star) {
    if (!star.data) return "";
    const parts = star.data.split("|");
    return parts[5] || "";
  }

  // ─── Tool handlers ───────────────────────────────────────────────────────────

  const toolHandlers = {
    navigate_to_star: async ({ star_name }) => {
      const star = findStar(star_name);
      if (!star)
        return { error: `Star "${star_name}" not found in the dataset` };
      if (!star.position)
        return { error: `No coordinates available for "${star_name}"` };
      if (!_navigator) return { error: "Scene navigator not available" };

      appendMessage(
        "agent",
        `🚀 Flying to **${star.secondName || star.name}**...`,
      );
      _navigator(star.name);
      _activeStar = star.name;

      return {
        success: true,
        star: star.name,
        common_name: star.secondName || null,
        distance_from_sun_ly: Math.round(starDistanceFromSun(star) * 10) / 10,
        spectral: getSpectralFromData(star),
      };
    },

    get_nearby_stars: async ({ radius_ly, from_star, limit = 10 }) => {
      let origin;
      if (from_star) {
        const s = findStar(from_star);
        if (!s) return { error: `Star "${from_star}" not found` };
        origin = s.position;
      } else {
        origin = _controls.target;
      }

      const nearby = _stars
        .filter((s) => s.position && s.position.distanceTo(origin) <= radius_ly)
        .sort(
          (a, b) =>
            a.position.distanceTo(origin) - b.position.distanceTo(origin),
        )
        .slice(0, limit)
        .map((s) => ({
          name: s.name,
          common_name: s.secondName || null,
          distance_ly: Math.round(s.position.distanceTo(origin) * 10) / 10,
          spectral: getSpectralFromData(s),
        }));

      return { count: nearby.length, radius_ly, stars: nearby };
    },

    search_stars_by_type: async ({
      spectral_prefix,
      max_distance_ly,
      limit = 10,
    }) => {
      const prefix = spectral_prefix.toUpperCase();
      let results = _stars.filter((s) => {
        const sp = getSpectralFromData(s).toUpperCase();
        return sp.startsWith(prefix);
      });

      if (max_distance_ly) {
        const sun = _stars.find((s) => s.name === "Sun");
        const sunPos = sun ? sun.position : { distanceTo: () => 0 };
        results = results.filter(
          (s) => s.position && s.position.distanceTo(sunPos) <= max_distance_ly,
        );
      }

      results = results
        .sort((a, b) => starDistanceFromSun(a) - starDistanceFromSun(b))
        .slice(0, limit)
        .map((s) => ({
          name: s.name,
          common_name: s.secondName || null,
          distance_from_sun_ly: Math.round(starDistanceFromSun(s) * 10) / 10,
          spectral: getSpectralFromData(s),
        }));

      return { spectral_prefix, count: results.length, stars: results };
    },

    highlight_stars: async ({ star_names, color }) => {
      // Remove previous highlights
      _highlights.forEach((h) => _scene.remove(h));
      _highlights = [];

      const colorMap = {
        cyan: 0x00ffff,
        orange: 0xff8800,
        green: 0x00ff88,
        red: 0xff3333,
        yellow: 0xffff00,
        purple: 0xcc44ff,
      };
      const hex = colorMap[color] || 0x00ffff;

      let found = 0;
      for (const name of star_names) {
        const star = findStar(name);
        if (!star || !star.position) continue;

        // Create a pulsing wireframe halo sphere
        const geo = new THREE.SphereGeometry(0.8, 8, 8);
        const mat = new THREE.MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: 0.25,
          wireframe: true,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(star.position);
        mesh.isHighlight = true;
        _scene.add(mesh);
        _highlights.push(mesh);
        found++;
      }

      // Pulse animation
      if (_highlights.length > 0) {
        let t = 0;
        const pulse = () => {
          if (_highlights.length === 0) return;
          t += 0.05;
          _highlights.forEach((h) => {
            h.material.opacity = 0.15 + 0.15 * Math.sin(t);
          });
          requestAnimationFrame(pulse);
        };
        pulse();
      }

      return { highlighted: found, color };
    },

    clear_highlights: async () => {
      _highlights.forEach((h) => _scene.remove(h));
      _highlights = [];
      return { success: true };
    },

    get_current_position: async () => {
      const pos = _controls.target;
      const nearby = _stars
        .filter((s) => s.position && s.position.distanceTo(pos) < 50)
        .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
        .slice(0, 5)
        .map((s) => ({
          name: s.name,
          common_name: s.secondName || null,
          distance_ly: Math.round(s.position.distanceTo(pos) * 10) / 10,
        }));

      return {
        camera_x: Math.round(pos.x),
        camera_y: Math.round(pos.y),
        camera_z: Math.round(pos.z),
        distance_from_sun_ly: Math.round(pos.length()),
        nearest_stars: nearby,
      };
    },

    get_star_details: async ({ star_name }) => {
      const star = findStar(star_name);
      if (!star) return { error: `Star "${star_name}" not found` };

      return {
        simbad_id: star.name,
        common_name: star.secondName || null,
        distance_from_sun_ly: Math.round(starDistanceFromSun(star) * 10) / 10,
        spectral_type: getSpectralFromData(star) || "no data",
        radius_data: getRadiusFromData(star) || "no data",
        position: star.position
          ? {
              x: Math.round(star.position.x),
              y: Math.round(star.position.y),
              z: Math.round(star.position.z),
            }
          : null,
      };
    },

    plan_tour: async ({ stops, pause_seconds = 4 }) => {
      const found = stops.map((name) => findStar(name)).filter(Boolean);
      if (found.length === 0)
        return { error: "None of the listed stars were found in the dataset" };
      if (!_navigator) return { error: "Scene navigator not available" };

      appendMessage("agent", `🗺 Starting tour of ${found.length} stars...`);
      // 3000ms matches recenter's animation (200 steps × ~15ms render interval)
      const FLIGHT_MS = 3000;

      for (const star of found) {
        if (!star.position) continue;
        appendMessage(
          "agent",
          `➡ **${star.secondName || star.name}** (${Math.round(starDistanceFromSun(star))} ly)`,
        );
        _navigator(star.name);
        _activeStar = star.name;
        await new Promise((r) =>
          setTimeout(r, FLIGHT_MS + pause_seconds * 1000),
        );
      }

      return { success: true, visited: found.map((s) => s.name) };
    },
  };

  // ─── Agent loop ──────────────────────────────────────────────────────────────

  const _SYSTEM_BASE = `You are an astronomical agent embedded in an interactive 3D map of the solar stellar neighborhood (radius ~2000 light-years, SIMBAD database).

You have tools to control the map:
- navigate_to_star: fly the camera to a star
- get_nearby_stars: find neighboring stars
- search_stars_by_type: search by spectral class
- highlight_stars: visually highlight stars on the 3D scene
- clear_highlights: remove all highlights
- get_current_position: find out where the camera currently is
- get_star_details: get technical data for a star
- plan_tour: launch an automatic multi-star tour

Communication style: friendly, enthusiastic, concise. Respond in the user's language. Use tools actively — don't just describe, show. After navigating, share a brief interesting fact about the star. When returning search results, always highlight them on the scene. Stars in the dataset are stored under SIMBAD IDs (e.g. "* alf CMa" = Sirius, "* alf Ori" = Betelgeuse) — account for this when calling tools.`;

  // Builds a fresh system prompt injected on every API call.
  // Uses camera.position (not controls.target) so WASD movement and
  // orbital rotation are reflected accurately.
  // _activeStar is preferred when the camera is still near it (< 15 ly);
  // otherwise falls back to distance-based nearest-star search.
  function buildSystemPrompt() {
    if (!_controls) return _SYSTEM_BASE;
    const pos = _controls.target;
    const distFromSun = Math.round(pos.length());

    let locationLine;
    if (_activeStar) {
      const focused = _stars.find((s) => s.name === _activeStar);
      const d =
        focused && focused.position
          ? Math.round(focused.position.distanceTo(pos) * 10) / 10
          : null;
      if (d !== null && d < 15) {
        const label = focused.secondName || focused.name;
        locationLine =
          d < 1
            ? `Focused on: ${label}.`
            : `Focused on: ${label} (${d} ly from camera).`;
      } else {
        _activeStar = null; // camera moved far from active star — reset
      }
    }

    if (!locationLine) {
      const nearby = _stars
        .filter((s) => s.position && s.position.distanceTo(pos) < 15)
        .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
        .slice(0, 3)
        .map((s) => {
          const d = Math.round(s.position.distanceTo(pos) * 10) / 10;
          return (
            (s.secondName || s.name) + (d > 0 ? ` (${d} ly)` : " (current)")
          );
        });
      locationLine = nearby.length
        ? `Nearest: ${nearby.join(", ")}.`
        : `Position: (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}).`;
    }

    return `${_SYSTEM_BASE}\n\n[Current camera position: ${distFromSun} ly from Sun. ${locationLine} Always use this as the reference point for distance-based queries unless the user specifies otherwise.]`;
  }

  async function runAgentLoop(userMessage) {
    const apiKey = getApiKey();
    if (!apiKey) {
      showApiSetup();
      return;
    }

    _conversationHistory.push({ role: "user", content: userMessage });
    setThinking(true);

    try {
      let iterations = 0;
      const MAX_ITERATIONS = 8;

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-dangerous-direct-browser-access": "true",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1024,
            system: buildSystemPrompt(),
            tools: TOOLS,
            messages: _conversationHistory,
          }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          if (response.status === 401) {
            appendMessage("error", "❌ Invalid API key.");
            sessionStorage.removeItem(SESSION_KEY);
            setTimeout(showApiSetup, 1000);
            break;
          }
          throw new Error(err.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();

        // Add assistant response to history
        _conversationHistory.push({ role: "assistant", content: data.content });

        // Show text blocks to the user
        for (const block of data.content) {
          if (block.type === "text" && block.text.trim()) {
            appendMessage("agent", block.text.trim());
          }
        }

        // Stop if turn is complete
        if (data.stop_reason === "end_turn") break;

        // Execute tool calls
        if (data.stop_reason === "tool_use") {
          const toolUseBlocks = data.content.filter(
            (b) => b.type === "tool_use",
          );
          const toolResults = [];

          for (const toolUse of toolUseBlocks) {
            showToolCall(toolUse.name, toolUse.input);
            let result;
            try {
              const handler = toolHandlers[toolUse.name];
              result = handler
                ? await handler(toolUse.input)
                : { error: `Tool "${toolUse.name}" is not implemented` };
            } catch (e) {
              result = { error: e.message };
            }

            toolResults.push({
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(result),
            });
          }

          // Return tool results to the agent
          _conversationHistory.push({ role: "user", content: toolResults });
          continue;
        }

        break; // any other stop_reason
      }
    } catch (e) {
      appendMessage("error", `⚠ Error: ${e.message}`);
    } finally {
      setThinking(false);
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  function init({ scene, camera, controls, stars, names }) {
    _scene = scene;
    _camera = camera;
    _controls = controls;
    _stars = stars;
    _names = names || [];
    createUI();
    console.log("[StarAgent] Initialized. Stars in dataset:", _stars.length);
  }

  // Called from index.html after scene is ready.
  // fn(simbadId) must look up the star in starPositions and call recenter().
  function setNavigator(fn) {
    _navigator = fn;
  }

  // ─── UI ──────────────────────────────────────────────────────────────────────

  const STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=Space+Mono:ital,wght@0,400;0,700;1,400&display=swap');

    #sa-toggle {
      position: fixed; bottom: 28px; left: 28px;
      width: 52px; height: 52px;
      border-radius: 50%;
      background: rgba(10, 15, 25, 0.92);
      border: 1.5px solid rgba(25, 150, 175, 0.5);
      color: #1996af;
      font-size: 22px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      z-index: 9999;
      box-shadow: 0 4px 20px rgba(0,0,0,0.6), 0 0 0 0 rgba(25,150,175,0.4);
      transition: all 0.25s ease;
      backdrop-filter: blur(10px);
    }
    #sa-toggle:hover {
      border-color: rgba(25,150,175,0.9);
      box-shadow: 0 4px 20px rgba(0,0,0,0.6), 0 0 20px rgba(25,150,175,0.3);
      transform: scale(1.05);
    }
    #sa-toggle.sa-active {
      background: rgba(25, 150, 175, 0.15);
      box-shadow: 0 4px 20px rgba(0,0,0,0.6), 0 0 30px rgba(25,150,175,0.4);
    }

    #sa-panel {
      position: fixed; bottom: 92px; left: 28px;
      width: 360px; max-height: 60vh;
      background: rgba(6, 10, 18, 0.95);
      border: 1px solid rgba(25, 150, 175, 0.25);
      border-radius: 16px;
      box-shadow: 0 16px 60px rgba(0,0,0,0.8), 0 0 0 1px rgba(25,150,175,0.06);
      font-family: 'Space Mono', 'Courier New', monospace;
      display: none; flex-direction: column;
      z-index: 9998;
      backdrop-filter: blur(16px);
      overflow: hidden;
      transition: opacity 0.3s ease, transform 0.3s ease;
      opacity: 0; transform: translateY(12px) scale(0.98);
    }
    #sa-panel.sa-open {
      opacity: 1; transform: translateY(0) scale(1);
    }

    #sa-header {
      padding: 14px 16px 12px;
      border-bottom: 1px solid rgba(25,150,175,0.15);
      display: flex; align-items: center; gap: 10px;
      background: rgba(25,150,175,0.04);
    }
    .sa-status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #1996af;
      box-shadow: 0 0 6px #1996af;
      flex-shrink: 0;
    }
    .sa-status-dot.sa-busy { animation: sa-blink 0.8s ease-in-out infinite; }
    @keyframes sa-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
    #sa-header-text { flex: 1; }
    #sa-title { font-size: 12px; color: #c8dde8; font-weight: 700; letter-spacing: 0.5px; }
    #sa-subtitle { font-size: 10px; color: #3a6070; margin-top: 1px; }

    #sa-messages {
      flex: 1; overflow-y: auto; padding: 12px 14px;
      display: flex; flex-direction: column; gap: 10px;
      scroll-behavior: smooth;
    }
    #sa-messages::-webkit-scrollbar { width: 3px; }
    #sa-messages::-webkit-scrollbar-thumb { background: rgba(25,150,175,0.25); border-radius: 2px; }

    .sa-msg { font-size: 12.5px; line-height: 1.65; animation: sa-fadein 0.2s ease; }
    @keyframes sa-fadein { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }

    .sa-msg-user {
      color: #90b8c8; padding: 8px 12px;
      background: rgba(25,150,175,0.07);
      border-radius: 10px 10px 2px 10px;
      border-left: 2px solid rgba(25,150,175,0.3);
      align-self: flex-end; max-width: 90%;
    }
    .sa-msg-agent {
      color: #c0d8e0; padding: 8px 12px;
      background: rgba(255,255,255,0.03);
      border-radius: 2px 10px 10px 10px;
      border-left: 2px solid rgba(100,180,200,0.15);
      max-width: 95%;
    }
    .sa-msg-agent strong, .sa-msg-agent b { color: #e8f4f8; font-weight: 700; }
    .sa-msg-tool {
      font-size: 11px; color: #2a7a8a;
      padding: 4px 10px;
      border-left: 2px solid rgba(25,150,175,0.2);
      margin-left: 4px;
    }
    .sa-msg-tool .sa-tool-name { color: #1996af; font-weight: 700; }
    .sa-msg-error {
      color: #c05050; font-size: 12px; padding: 6px 10px;
      background: rgba(200,50,50,0.06); border-radius: 6px;
      border-left: 2px solid rgba(200,80,80,0.3);
    }
    .sa-thinking {
      display: flex; align-items: center; gap: 8px;
      color: #2a7a8a; font-size: 11.5px; padding: 6px 0;
    }
    .sa-dot { width: 5px; height: 5px; border-radius: 50%; background: #1996af; }
    .sa-dot:nth-child(1) { animation: sa-bounce 1.2s 0s infinite; }
    .sa-dot:nth-child(2) { animation: sa-bounce 1.2s 0.2s infinite; }
    .sa-dot:nth-child(3) { animation: sa-bounce 1.2s 0.4s infinite; }
    @keyframes sa-bounce {
      0%,80%,100%{transform:scale(0.7);opacity:0.3}
      40%{transform:scale(1.1);opacity:1}
    }

    #sa-suggestions {
      padding: 0 14px 10px;
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .sa-chip {
      font-family: 'Space Mono', monospace; font-size: 10.5px;
      padding: 5px 10px;
      border: 1px solid rgba(25,150,175,0.25); border-radius: 20px;
      color: #3a8090; cursor: pointer;
      background: rgba(25,150,175,0.04);
      transition: all 0.18s ease;
    }
    .sa-chip:hover {
      border-color: rgba(25,150,175,0.6); color: #1996af;
      background: rgba(25,150,175,0.1);
    }

    #sa-input-row {
      display: flex; gap: 8px;
      padding: 10px 14px 14px;
      border-top: 1px solid rgba(25,150,175,0.1);
    }
    #sa-input {
      flex: 1;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(25,150,175,0.2); border-radius: 10px;
      color: #c8dde8; font-family: 'Space Mono', monospace;
      font-size: 12px; padding: 9px 12px;
      outline: none; transition: border-color 0.2s; resize: none;
    }
    #sa-input:focus { border-color: rgba(25,150,175,0.55); }
    #sa-input::placeholder { color: #2a5060; }
    #sa-send {
      background: rgba(25,150,175,0.15);
      border: 1px solid rgba(25,150,175,0.3); border-radius: 10px;
      color: #1996af; font-size: 16px; padding: 9px 14px;
      cursor: pointer; transition: all 0.2s; flex-shrink: 0;
    }
    #sa-send:hover:not(:disabled) {
      background: rgba(25,150,175,0.3);
      border-color: rgba(25,150,175,0.6);
    }
    #sa-send:disabled { opacity: 0.3; cursor: not-allowed; }

    #sa-api-setup {
      padding: 20px; display: none;
      flex-direction: column; gap: 10px;
    }
    #sa-api-setup p { color: #3a6070; font-size: 11.5px; line-height: 1.7; margin: 0; }
    #sa-api-input {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(25,150,175,0.25); border-radius: 8px;
      color: #90b8c8; font-family: 'Space Mono', monospace;
      font-size: 11px; padding: 9px 12px;
      outline: none; transition: border-color 0.2s;
    }
    #sa-api-input:focus { border-color: rgba(25,150,175,0.6); }
    #sa-api-save {
      background: rgba(25,150,175,0.12);
      border: 1px solid rgba(25,150,175,0.3); border-radius: 8px;
      color: #1996af; font-family: 'Space Mono', monospace;
      font-size: 11.5px; padding: 10px;
      cursor: pointer; transition: background 0.2s;
    }
    #sa-api-save:hover { background: rgba(25,150,175,0.25); }
  `;

  const SUGGESTIONS = [
    "Fly to Betelgeuse",
    "Nearest stars to us",
    "Find red giants",
    "G-type stars like the Sun",
    "Tour of the brightest stars",
  ];

  function createUI() {
    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.appendChild(style);

    // Toggle button
    const toggle = document.createElement("button");
    toggle.id = "sa-toggle";
    toggle.innerHTML = "🤖";
    toggle.title = "Astronomical Agent";
    document.body.appendChild(toggle);

    // Panel
    const panel = document.createElement("div");
    panel.id = "sa-panel";
    panel.innerHTML = `
      <div id="sa-header">
        <div class="sa-status-dot" id="sa-dot"></div>
        <div id="sa-header-text">
          <div id="sa-title">ASTRONOMICAL AGENT</div>
          <div id="sa-subtitle">Controls the map &bull; Claude AI</div>
        </div>
      </div>

      <div id="sa-api-setup">
        <p>Enter your Anthropic API key to activate the agent.<br>
        The key is stored only in the current tab's memory.</p>
        <input id="sa-api-input" type="password" placeholder="sk-ant-..." />
        <button id="sa-api-save">Activate Agent →</button>
      </div>

      <div id="sa-messages"></div>
      <div id="sa-suggestions"></div>
      <div id="sa-input-row">
        <textarea id="sa-input" rows="1" placeholder="Ask the agent or give a command..."></textarea>
        <button id="sa-send">↑</button>
      </div>
    `;
    document.body.appendChild(panel);

    // Suggestion chips
    const sugg = document.getElementById("sa-suggestions");
    SUGGESTIONS.forEach((text) => {
      const chip = document.createElement("button");
      chip.className = "sa-chip";
      chip.textContent = text;
      chip.onclick = () => sendMessage(text);
      sugg.appendChild(chip);
    });

    // Events
    toggle.onclick = () => togglePanel();
    document.getElementById("sa-send").onclick = () => {
      const val = document.getElementById("sa-input").value.trim();
      if (val) sendMessage(val);
    };
    document.getElementById("sa-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const val = e.target.value.trim();
        if (val) sendMessage(val);
      }
    });

    // dat.GUI binds toggleHide() to window 'keydown' (bubble phase) and checks
    // activeElement.type !== 'text' — textarea.type is "textarea", not "text",
    // so dat.GUI still intercepts keys even when the textarea has focus.
    // Fix: intercept at document bubble (runs before window bubble) and swallow
    // all keydown events while the agent panel is visible.
    document.addEventListener("keydown", (e) => {
      const panel = document.getElementById("sa-panel");
      if (panel && panel.style.display !== "none") {
        e.stopPropagation();
      }
    });
    document.getElementById("sa-api-save").onclick = saveApiKey;

    // Welcome message
    setTimeout(() => {
      if (getApiKey()) {
        appendMessage(
          "agent",
          "👋 Hello! I'm your astronomical agent. I can fly to stars, search by type, highlight groups, and build tours. What shall we explore?",
        );
        showSuggestions(true);
      } else {
        showApiSetup();
      }
    }, 500);
  }

  function togglePanel() {
    const panel = document.getElementById("sa-panel");
    const toggle = document.getElementById("sa-toggle");
    const isOpen = panel.classList.contains("sa-open");
    if (isOpen) {
      panel.classList.remove("sa-open");
      toggle.classList.remove("sa-active");
      setTimeout(() => {
        panel.style.display = "none";
      }, 300);
    } else {
      panel.style.display = "flex";
      requestAnimationFrame(() => {
        requestAnimationFrame(() => panel.classList.add("sa-open"));
      });
      toggle.classList.add("sa-active");
      scrollMessages();
    }
  }

  function showApiSetup() {
    document.getElementById("sa-api-setup").style.display = "flex";
    document.getElementById("sa-messages").style.display = "none";
    document.getElementById("sa-suggestions").style.display = "none";
    document.getElementById("sa-input-row").style.display = "none";
    const panel = document.getElementById("sa-panel");
    if (!panel.classList.contains("sa-open")) togglePanel();
  }

  function saveApiKey() {
    const val = document.getElementById("sa-api-input").value.trim();
    if (!val.startsWith("sk-")) {
      document.getElementById("sa-api-input").style.borderColor = "#c05050";
      return;
    }
    sessionStorage.setItem(SESSION_KEY, val);
    document.getElementById("sa-api-setup").style.display = "none";
    document.getElementById("sa-messages").style.display = "flex";
    document.getElementById("sa-suggestions").style.display = "flex";
    document.getElementById("sa-input-row").style.display = "flex";
    appendMessage("agent", "✅ Ready! What shall we explore on the map?");
    showSuggestions(true);
  }

  function getApiKey() {
    return sessionStorage.getItem(SESSION_KEY) || "";
  }

  function showSuggestions(visible) {
    const el = document.getElementById("sa-suggestions");
    if (el) el.style.display = visible ? "flex" : "none";
  }

  function sendMessage(text) {
    if (_isThinking) return;
    document.getElementById("sa-input").value = "";
    showSuggestions(false);
    appendMessage("user", text);
    runAgentLoop(text);
  }

  function appendMessage(type, text) {
    const msgs = document.getElementById("sa-messages");
    if (!msgs) return;
    const thinking = msgs.querySelector(".sa-thinking");
    if (thinking && type !== "thinking") thinking.remove();
    const div = document.createElement("div");
    div.className = `sa-msg sa-msg-${type}`;
    // Simple markdown: **bold**
    div.innerHTML = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    msgs.appendChild(div);
    scrollMessages();
  }

  function showToolCall(toolName, input) {
    const msgs = document.getElementById("sa-messages");
    if (!msgs) return;
    const div = document.createElement("div");
    div.className = "sa-msg sa-msg-tool";
    const params = Object.entries(input)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(", ");
    div.innerHTML = `<span class="sa-tool-name">⚙ ${toolName}</span> <span style="color:#1a5060">${params}</span>`;
    msgs.appendChild(div);
    scrollMessages();
  }

  function setThinking(active) {
    _isThinking = active;
    const dot = document.getElementById("sa-dot");
    const send = document.getElementById("sa-send");
    const msgs = document.getElementById("sa-messages");
    if (!msgs) return;
    if (active) {
      if (dot) dot.classList.add("sa-busy");
      if (send) send.disabled = true;
      const thinking = document.createElement("div");
      thinking.className = "sa-thinking";
      thinking.innerHTML = `<div class="sa-dot"></div><div class="sa-dot"></div><div class="sa-dot"></div><span>Thinking...</span>`;
      msgs.appendChild(thinking);
      scrollMessages();
    } else {
      if (dot) dot.classList.remove("sa-busy");
      if (send) send.disabled = false;
      const thinking = msgs.querySelector(".sa-thinking");
      if (thinking) thinking.remove();
      showSuggestions(true);
    }
  }

  function scrollMessages() {
    const msgs = document.getElementById("sa-messages");
    if (msgs)
      setTimeout(() => {
        msgs.scrollTop = msgs.scrollHeight;
      }, 50);
  }

  function setActiveStar(name) {
    _activeStar = name || null;
  }

  return { init, setNavigator, setActiveStar };
})();

window.StarAgent = StarAgent;
