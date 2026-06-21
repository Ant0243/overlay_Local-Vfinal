// /server.js
const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const photosDir = path.join(__dirname, "public", "photos");

app.get("/api/photos", (_req, res) => {
    fs.readdir(photosDir, { withFileTypes: true }, (error, entries) => {
        if (error) {
            res.json([]);
            return;
        }

        const photos = entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name))
            .sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }))
            .map((name) => ({ name, url: `/photos/${encodeURIComponent(name)}` }));

        res.json(photos);
    });
});

app.use(express.static("public"));

const rooms = new Map();
const roomHistory = new Map();

const sharedMeeting = {
    clubs: { A: "CLUB A", B: "CLUB B" },
    teamScore: { A: 0, B: 0 }
};

function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
}

function opposite(side) {
    return side === "B" ? "A" : "B";
}

function safeScore(score) {
    return {
        A: Math.max(0, Math.floor(Number(score?.A || 0))),
        B: Math.max(0, Math.floor(Number(score?.B || 0)))
    };
}

function syncSharedMeeting(sourceRoom) {
    for (const [roomName, state] of rooms.entries()) {
        if (roomName === sourceRoom) continue;
        const next = {
            ...state,
            clubs: cloneState(sharedMeeting.clubs),
            teamScore: cloneState(sharedMeeting.teamScore)
        };
        rooms.set(roomName, next);
        io.to(roomName).emit("state", next);
    }
}

function syncSharedClubs(sourceRoom) {
    syncSharedMeeting(sourceRoom);
}

function getDefaultState() {
    return {
        mode: "singles",
        roundName: "MATCH",
        bestOf: 5,
        clubs: cloneState(sharedMeeting.clubs),
        players: { A: "JOUEUR A", B: "JOUEUR B" },
        playerPhotos: { A: "", B: "" },
        rankings: { A: "1", B: "2" },
        points: { A: 0, B: 0 },
        teamScore: cloneState(sharedMeeting.teamScore),
        showTeamScore: true,
        sets: { A: 0, B: 0 },
        server: "A",
        setStartServer: "A",
        pointLog: [],
        servePointsWon: { A: 0, B: 0 },
        setHistory: [],
        timeoutActive: false,
        timeoutBy: null,
        timeoutDurationSec: 60,
        timeoutStartedAt: null,
        timeoutUsed: { A: false, B: false }
    };
}

function getRoomState(room) {
    if (!rooms.has(room)) {
        rooms.set(room, getDefaultState());
        roomHistory.set(room, []);
    }
    return rooms.get(room);
}

function getRoomHistory(room) {
    if (!roomHistory.has(room)) roomHistory.set(room, []);
    return roomHistory.get(room);
}

function pushHistory(room, state) {
    const history = getRoomHistory(room);
    history.push(cloneState(state));
    if (history.length > 50) history.shift();
}

function emitRoomState(room, state) {
    const next = {
        ...state,
        clubs: cloneState(sharedMeeting.clubs),
        teamScore: cloneState(sharedMeeting.teamScore)
    };
    rooms.set(room, next);
    io.to(room).emit("state", next);
}

function freshRoom(room) {
    const fresh = getDefaultState();
    rooms.set(room, fresh);
    roomHistory.set(room, []);
    return fresh;
}

function resetMatchState(state) {
    return {
        ...state,
        clubs: cloneState(sharedMeeting.clubs),
        teamScore: cloneState(sharedMeeting.teamScore),
        players: { A: "JOUEUR A", B: "JOUEUR B" },
        playerPhotos: { A: "", B: "" },
        rankings: { A: "1", B: "2" },
        points: { A: 0, B: 0 },
        showTeamScore: state.showTeamScore,
        sets: { A: 0, B: 0 },
        server: "A",
        setStartServer: "A",
        pointLog: [],
        servePointsWon: { A: 0, B: 0 },
        setHistory: [],
        timeoutActive: false,
        timeoutBy: null,
        timeoutStartedAt: null,
        timeoutUsed: { A: false, B: false }
    };
}

function resetMeetingState() {
    sharedMeeting.clubs = { A: "CLUB A", B: "CLUB B" };
    sharedMeeting.teamScore = { A: 0, B: 0 };
    return getDefaultState();
}

function updateServerFromPoints(state) {
    const total = Number(state.points?.A || 0) + Number(state.points?.B || 0);
    const firstServer = state.setStartServer === "B" ? "B" : "A";
    if (total >= 20) {
        state.server = total % 2 === 0 ? firstServer : opposite(firstServer);
        return;
    }
    const block = Math.floor(total / 2);
    state.server = block % 2 === 0 ? firstServer : opposite(firstServer);
}

function setsToWin(state) {
    const bestOf = Number.isFinite(Number(state.bestOf)) ? Number(state.bestOf) : 5;
    return Math.ceil(bestOf / 2);
}

function matchLocked(state) {
    const needed = setsToWin(state);
    return Number(state.sets?.A || 0) >= needed || Number(state.sets?.B || 0) >= needed;
}

function winSetIfNeeded(state, side) {
    const otherSide = opposite(side);
    const points = state.points[side];
    const otherPoints = state.points[otherSide];
    if (points < 11 || points - otherPoints < 2) return false;
    state.setHistory.push({
        winner: side,
        loser: otherSide,
        score: { A: state.points.A, B: state.points.B },
        firstServer: state.setStartServer === "B" ? "B" : "A",
        endServer: state.server,
        at: new Date().toISOString()
    });
    state.sets[side] += 1;
    state.points = { A: 0, B: 0 };
    state.setStartServer = opposite(state.setStartServer === "B" ? "B" : "A");
    state.server = state.setStartServer;
    return true;
}

function logPoint(state, side) {
    const serverSide = state.server === "B" ? "B" : "A";
    const onServe = side === serverSide;
    const pointNumber = Number(state.points.A || 0) + Number(state.points.B || 0) + 1;
    state.pointLog.push({
        winner: side,
        server: serverSide,
        onServe,
        setIndex: Number(state.sets.A || 0) + Number(state.sets.B || 0) + 1,
        setsBefore: { A: state.sets.A, B: state.sets.B },
        setScoreBefore: { A: state.points.A, B: state.points.B },
        scoreAfter: {
            A: state.points.A + (side === "A" ? 1 : 0),
            B: state.points.B + (side === "B" ? 1 : 0)
        },
        pointNumber,
        at: new Date().toISOString()
    });
    if (state.pointLog.length > 256) state.pointLog.shift();
    if (onServe) state.servePointsWon[side] += 1;
}

function applyAction(room, action, state) {
    switch (action.type) {
        case "APPLY_SETTINGS": {
            const payload = action.payload || {};
            state.mode = payload.mode === "doubles" ? "doubles" : "singles";
            state.roundName = String(payload.roundName || "MATCH").trim() || "MATCH";
            state.bestOf = Number.isFinite(Number(payload.bestOf)) ? Number(payload.bestOf) : 5;
            if (payload.clubs) {
                sharedMeeting.clubs = { ...sharedMeeting.clubs, ...payload.clubs };
                state.clubs = cloneState(sharedMeeting.clubs);
                syncSharedMeeting(room);
            }
            state.players = { ...state.players, ...(payload.players || {}) };
            state.playerPhotos = { ...(state.playerPhotos || {}), ...(payload.playerPhotos || {}) };
            state.rankings = { ...state.rankings, ...(payload.rankings || {}) };
            return state;
        }
        case "POINT_A":
            if (matchLocked(state)) return state;
            logPoint(state, "A");
            state.points.A += 1;
            if (!winSetIfNeeded(state, "A")) updateServerFromPoints(state);
            return state;
        case "POINT_B":
            if (matchLocked(state)) return state;
            logPoint(state, "B");
            state.points.B += 1;
            if (!winSetIfNeeded(state, "B")) updateServerFromPoints(state);
            return state;
        case "TEAM_POINT_A":
            sharedMeeting.teamScore.A += 1;
            state.teamScore = cloneState(sharedMeeting.teamScore);
            syncSharedMeeting(room);
            return state;
        case "TEAM_POINT_B":
            sharedMeeting.teamScore.B += 1;
            state.teamScore = cloneState(sharedMeeting.teamScore);
            syncSharedMeeting(room);
            return state;
        case "TOGGLE_TEAM_SCORE":
            state.showTeamScore = state.showTeamScore === false;
            return state;
        case "TIMEOUT_START": {
            const by = action.by === "B" ? "B" : "A";
            state.timeoutActive = true;
            state.timeoutBy = by;
            state.timeoutStartedAt = new Date().toISOString();
            state.timeoutUsed[by] = true;
            return state;
        }
        case "TIMEOUT_END":
            state.timeoutActive = false;
            state.timeoutBy = null;
            state.timeoutStartedAt = null;
            return state;
        case "SET_SERVE":
            state.server = action.serve === "B" ? "B" : "A";
            state.setStartServer = state.server;
            return state;
        case "UNDO": {
            const previous = getRoomHistory(room).pop();
            return previous || state;
        }
        case "RESET_MATCH":
            return resetMatchState(state);
        case "RESET_RENCONTRE":
            return resetMeetingState();
        default:
            return state;
    }
}

io.on("connection", (socket) => {
    socket.on("join", (room) => {
        socket.join(room);
        socket.emit("state", getRoomState(room));
    });

    socket.on("action", (action) => {
        if (!action || !action.room || !action.type) return;
        const current = getRoomState(action.room);
        if (action.type === "UNDO") {
            const previous = getRoomHistory(action.room).pop();
            if (!previous) return;
            sharedMeeting.teamScore = safeScore(previous.teamScore || sharedMeeting.teamScore);
            emitRoomState(action.room, previous);
            syncSharedMeeting(action.room);
            return;
        }
        const previous = cloneState(current);
        const next = applyAction(action.room, action, cloneState(current));
        pushHistory(action.room, previous);
        emitRoomState(action.room, next);
        if (action.type === "RESET_RENCONTRE") syncSharedMeeting(action.room);
    });

    socket.on("update-state", ({ room, patch }) => {
        if (!room || !patch) return;
        const current = getRoomState(room);
        if (patch.clubs) sharedMeeting.clubs = { ...sharedMeeting.clubs, ...patch.clubs };
        if (patch.teamScore) sharedMeeting.teamScore = safeScore({ ...sharedMeeting.teamScore, ...patch.teamScore });
        const next = {
            ...current,
            ...patch,
            clubs: cloneState(sharedMeeting.clubs),
            players: { ...current.players, ...(patch.players || {}) },
            playerPhotos: { ...(current.playerPhotos || {}), ...(patch.playerPhotos || {}) },
            rankings: { ...current.rankings, ...(patch.rankings || {}) },
            points: { ...current.points, ...(patch.points || {}) },
            teamScore: cloneState(sharedMeeting.teamScore),
            sets: { ...current.sets, ...(patch.sets || {}) },
            timeoutUsed: { ...current.timeoutUsed, ...(patch.timeoutUsed || {}) }
        };
        pushHistory(room, current);
        emitRoomState(room, next);
        if (patch.clubs || patch.teamScore) syncSharedMeeting(room);
    });

    socket.on("reset-room", (room) => {
        if (!room) return;
        const fresh = freshRoom(room);
        io.to(room).emit("state", fresh);
    });

    socket.on("get-stats", (room) => {
        if (!room) return;
        socket.emit("stats", buildStats(getRoomState(room)));
    });
});

function buildStats(state) {
    const history = Array.isArray(state.pointLog) ? state.pointLog : [];
    const last16 = history.slice(-16);
    const setHistory = Array.isArray(state.setHistory) ? state.setHistory : [];
    const summarize = (entries) => {
        const pointsWon = { A: 0, B: 0 };
        const onServeWon = { A: 0, B: 0 };
        const onReceiveWon = { A: 0, B: 0 };
        for (const entry of entries) {
            if (entry.winner === "A") pointsWon.A += 1;
            if (entry.winner === "B") pointsWon.B += 1;
            if (entry.winner === "A" && entry.onServe) onServeWon.A += 1;
            if (entry.winner === "B" && entry.onServe) onServeWon.B += 1;
            if (entry.winner === "A" && !entry.onServe) onReceiveWon.A += 1;
            if (entry.winner === "B" && !entry.onServe) onReceiveWon.B += 1;
        }
        return {
            total: entries.length,
            pointsWon,
            onServeWon,
            onReceiveWon,
            serveAttempts: {
                A: entries.filter((entry) => entry.server === "A").length,
                B: entries.filter((entry) => entry.server === "B").length
            }
        };
    };
    const overall = summarize(history);
    const last16Summary = summarize(last16);
    const streaks = computeStreaks(history);
    const closeSets = setHistory.filter((set) => Math.abs(Number(set.score?.A || 0) - Number(set.score?.B || 0)) <= 2);
    const savedPoints = computeSavedPoints(history, setHistory, setsToWin(state));
    const efficiency = {
        serve: { A: percent(overall.onServeWon.A, overall.serveAttempts.A), B: percent(overall.onServeWon.B, overall.serveAttempts.B) },
        receive: { A: percent(overall.onReceiveWon.A, overall.serveAttempts.B), B: percent(overall.onReceiveWon.B, overall.serveAttempts.A) }
    };
    const setPointTimeline = history.map((entry) => ({
        winner: entry.winner,
        server: entry.server,
        onServe: entry.onServe,
        setScoreBefore: entry.setScoreBefore,
        scoreAfter: entry.scoreAfter,
        setsBefore: entry.setsBefore,
        savedSetPoint: isSavedSetPoint(entry),
        savedMatchPoint: isSavedMatchPoint(entry, setsToWin(state)),
        at: entry.at
    }));
    return {
        roomState: state,
        overall,
        last16: last16Summary,
        servePointsWon: { ...state.servePointsWon },
        receivePointsWon: overall.onReceiveWon,
        efficiency,
        streaks,
        closeSets: closeSets.map((set) => ({ winner: set.winner, loser: set.loser, score: set.score, firstServer: set.firstServer, endServer: set.endServer, at: set.at })),
        setHistory,
        savedPoints,
        setPointTimeline,
        recentPoints: last16.map((entry) => ({ winner: entry.winner, server: entry.server, onServe: entry.onServe, setScoreBefore: entry.setScoreBefore, scoreAfter: entry.scoreAfter, setsBefore: entry.setsBefore, at: entry.at }))
    };
}

function computeStreaks(history) {
    let currentWinner = null;
    let currentLength = 0;
    let bestWinner = null;
    let bestLength = 0;
    for (const point of history) {
        if (point.winner === currentWinner) currentLength += 1;
        else {
            currentWinner = point.winner;
            currentLength = 1;
        }
        if (currentLength > bestLength) {
            bestLength = currentLength;
            bestWinner = currentWinner;
        }
    }
    return {
        current: currentWinner ? { winner: currentWinner, length: currentLength } : { winner: null, length: 0 },
        best: bestWinner ? { winner: bestWinner, length: bestLength } : { winner: null, length: 0 }
    };
}

function percent(won, attempts) {
    if (!attempts) return 0;
    return Math.round((won / attempts) * 100);
}

function isSetPointBefore(entry, side) {
    const score = entry.setScoreBefore || { A: 0, B: 0 };
    const opponent = opposite(side);
    const sideScore = Number(score[side] || 0);
    const opponentScore = Number(score[opponent] || 0);
    return sideScore >= 10 && sideScore - opponentScore >= 1;
}

function isMatchPointBefore(entry, side, setsNeeded) {
    const setsBefore = entry.setsBefore || { A: 0, B: 0 };
    return Number(setsBefore[side] || 0) === setsNeeded - 1 && isSetPointBefore(entry, side);
}

function isSavedSetPoint(entry) {
    return (entry.winner === "A" && isSetPointBefore(entry, "B")) || (entry.winner === "B" && isSetPointBefore(entry, "A"));
}

function isSavedMatchPoint(entry, setsNeeded) {
    return (entry.winner === "A" && isMatchPointBefore(entry, "B", setsNeeded)) ||
        (entry.winner === "B" && isMatchPointBefore(entry, "A", setsNeeded));
}

function computeSavedPoints(history, setHistory, setsNeeded) {
    const savedSetPoints = { A: 0, B: 0 };
    const savedMatchPoints = { A: 0, B: 0 };
    for (const point of history) {
        if (point.winner === "A" && isSetPointBefore(point, "B")) savedSetPoints.A += 1;
        if (point.winner === "B" && isSetPointBefore(point, "A")) savedSetPoints.B += 1;
        if (point.winner === "A" && isMatchPointBefore(point, "B", setsNeeded)) savedMatchPoints.A += 1;
        if (point.winner === "B" && isMatchPointBefore(point, "A", setsNeeded)) savedMatchPoints.B += 1;
    }
    return { setPoints: savedSetPoints, matchPoints: savedMatchPoints };
}

server.listen(3000, "0.0.0.0", () => {
    console.log("Serveur local: http://localhost:3000");
});
