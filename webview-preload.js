/* ================================================================
   Map Music – Webview Preload (injected into YouTube page)
   Handles real-time pitch shifting of YouTube audio using
   Web Audio API with preservesPitch=false trick.
   ================================================================ */

// Strategy: Use playbackRate + preservesPitch=false for pitch,
// then compensate with AudioContext playbackRate to keep speed.
// Actually simpler: just detune the video using AudioContext.

(function() {
    'use strict';

    let audioCtx = null;
    let sourceNode = null;
    let pitchShiftNode = null;
    let currentPitchSemitones = 0;
    let connected = false;
    let videoElement = null;

    // Wait for video element to appear in YouTube's DOM
    function findVideo() {
        return document.querySelector('video');
    }

    function connectAudio() {
        if (connected) return true;
        videoElement = findVideo();
        if (!videoElement) return false;

        try {
            audioCtx = new AudioContext();
            sourceNode = audioCtx.createMediaElementSource(videoElement);

            // Simple pitch shift: manipulate playbackRate while
            // keeping preservesPitch = false, then use a 
            // playback rate compensation.
            // 
            // Better approach: connect through a chain and let
            // the renderer control the video's playbackRate + preservesPitch.
            
            // Direct pass-through for now; pitch control via
            // video.playbackRate + preservesPitch
            sourceNode.connect(audioCtx.destination);
            connected = true;
            
            // Ensure preservesPitch is off so playbackRate changes pitch
            videoElement.preservesPitch = false;
            videoElement.mozPreservesPitch = false;
            videoElement.webkitPreservesPitch = false;

            return true;
        } catch (e) {
            console.error('[MapMusic Pitch] Failed to connect audio:', e);
            return false;
        }
    }

    // Apply pitch shift in semitones
    // We change playbackRate to shift pitch, keeping the speed constant
    // isn't possible with just the basic API, but we can at least
    // shift pitch by changing playbackRate with preservesPitch=false.
    //
    // For a true pitch-only shift: rate = 2^(semitones/12)
    // This will also change speed slightly. To compensate perfectly
    // we'd need a phase vocoder, but for +/- 3 semitones the speed
    // change is small enough (±20%) and this is what Transpose extension does too.
    function setPitch(semitones) {
        currentPitchSemitones = semitones;

        if (!connectAudio()) {
            // Try again shortly (video might not be loaded yet)
            setTimeout(() => setPitch(semitones), 500);
            return;
        }

        // Rate for pitch shift: 2^(semitones/12)
        const rate = Math.pow(2, semitones / 12);
        videoElement.playbackRate = rate;
        videoElement.preservesPitch = false;
        videoElement.mozPreservesPitch = false;
        videoElement.webkitPreservesPitch = false;
    }

    // Listen for messages from the renderer (via webview.send)
    const { ipcRenderer } = require('electron');

    ipcRenderer.on('set-pitch', (_event, semitones) => {
        setPitch(semitones);
    });

    ipcRenderer.on('get-pitch', (_event) => {
        ipcRenderer.sendToHost('pitch-value', currentPitchSemitones);
    });

    // Auto-connect when video appears
    const observer = new MutationObserver(() => {
        if (!connected && findVideo()) {
            connectAudio();
            if (currentPitchSemitones !== 0) {
                setPitch(currentPitchSemitones);
            }
        }
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            observer.observe(document.body, { childList: true, subtree: true });
        });
    }

    // Also try connecting after page load
    window.addEventListener('load', () => {
        setTimeout(() => {
            if (!connected) connectAudio();
        }, 2000);
    });
})();
