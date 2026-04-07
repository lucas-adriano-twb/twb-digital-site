document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('timer-form');
    const container = document.getElementById('timers-container');
    const btnToggleSeq = document.getElementById('btn-toggle-seq');
    const btnResetSeq = document.getElementById('btn-reset-seq');
    
    // Pre-populate with a standard sequence
    let timers = [
        { id: 1, name: 'Foco Profundo 1', type: 'work', total: 50*60, remaining: 50*60 },
        { id: 2, name: 'Descanso Ativo 1', type: 'rest', total: 10*60, remaining: 10*60 },
        { id: 3, name: 'Foco Profundo 2', type: 'work', total: 40*60, remaining: 40*60 },
        { id: 4, name: 'Descanso Longo', type: 'rest', total: 20*60, remaining: 20*60 }
    ];
    
    let currentTimerIndex = 0;
    let isSequenceRunning = false;
    let sequenceInterval = null;
    let audioCtx = null;
    let masterGain = null;
    let currentTimerState = { hasPlayedPreAlert: false, playedTicks: new Set() };
    
    let targetEndTime = null;
    let keepAliveOsc = null;
    let keepAliveGain = null;
    let wakeLock = null;
    let brownNoiseSource = null;
    let brownNoiseGain = null;
    
    // NEW: Global array to track scheduled audio nodes
    let scheduledAudioNodes = [];

    function resetTimerState() {
        currentTimerState = {
            hasPlayedPreAlert: false,
            playedTicks: new Set()
        };
    }

    function initAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            masterGain = audioCtx.createGain();
            masterGain.connect(audioCtx.destination);
            
            const volumeSlider = document.getElementById('global-volume');
            if (volumeSlider) {
                masterGain.gain.value = parseInt(volumeSlider.value) / 100;
            }
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    async function enableKeepAlive() {
        initAudio();
        if (!keepAliveOsc) {
            keepAliveOsc = audioCtx.createOscillator();
            keepAliveGain = audioCtx.createGain();
            keepAliveGain.gain.value = 0.00001; // Silent
            keepAliveOsc.connect(keepAliveGain);
            keepAliveGain.connect(masterGain);
            keepAliveOsc.start();
        }
        try {
            if ('wakeLock' in navigator && !wakeLock) {
                wakeLock = await navigator.wakeLock.request('screen');
            }
        } catch (err) {
            console.log('Wake Lock error:', err);
        }
    }

    function disableKeepAlive() {
        if (keepAliveOsc) {
            keepAliveOsc.stop();
            keepAliveOsc.disconnect();
            keepAliveGain.disconnect();
            keepAliveOsc = null;
            keepAliveGain = null;
        }
        if (wakeLock) {
            wakeLock.release().then(() => {
                wakeLock = null;
            });
        }
    }

    function startBrownNoise() {
        initAudio();
        if (brownNoiseSource) return;

        const bufferSize = audioCtx.sampleRate * 2;
        const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        let lastOut = 0;
        for (let i = 0; i < bufferSize; i++) {
            let white = Math.random() * 2 - 1;
            data[i] = (lastOut + (0.02 * white)) / 1.02;
            lastOut = data[i];
            data[i] *= 3.5; // compensate for gain
        }

        brownNoiseSource = audioCtx.createBufferSource();
        brownNoiseSource.buffer = buffer;
        brownNoiseSource.loop = true;

        brownNoiseGain = audioCtx.createGain();
        const noiseVolumeInput = document.getElementById('brown-noise-volume');
        const noiseVol = noiseVolumeInput ? parseInt(noiseVolumeInput.value) / 100 : 0.1;
        brownNoiseGain.gain.value = noiseVol;

        brownNoiseSource.connect(brownNoiseGain);
        brownNoiseGain.connect(masterGain);
        brownNoiseSource.start();
    }

    function stopBrownNoise() {
        if (brownNoiseSource) {
            brownNoiseSource.stop();
            brownNoiseSource.disconnect();
            brownNoiseGain.disconnect();
            brownNoiseSource = null;
            brownNoiseGain = null;
        }
    }

    function manageBrownNoiseState() {
        if (timers.length === 0) {
            stopBrownNoise();
            return;
        }
        
        const enableBrownNoise = document.getElementById('enable-brown-noise');
        const isBrownNoiseEnabled = enableBrownNoise ? enableBrownNoise.checked : false;

        // NEW: Continuous Noise Override - Plays across ENTIRE sequence
        if (isSequenceRunning && isBrownNoiseEnabled) {
            startBrownNoise();
        } else {
            stopBrownNoise();
        }
    }

    // NEW: Cancellation Function
    function cancelScheduledAudio() {
        scheduledAudioNodes.forEach(node => {
            try {
                node.stop();
                node.disconnect();
            } catch (e) {
                // Ignore if already stopped
            }
        });
        scheduledAudioNodes = [];
    }

    // UPDATED: Accepts startTime for scheduling
    function playMelody(type, duration = null, startTime = null) {
        initAudio();
        const now = startTime !== null ? startTime : audioCtx.currentTime;
        const playDuration = duration || (type === 'chime' ? 0.9 : type === 'retro' ? 0.6 : 2);
        
        if (type === 'chime') {
            // Notification Chime: Major 3rd interval sequence (C5, E5, G5)
            const notes = [523.25, 659.25, 783.99];
            const noteDuration = 0.3;
            const sequenceDuration = notes.length * noteDuration;
            const iterations = Math.ceil(playDuration / sequenceDuration);
            
            for (let iter = 0; iter < iterations; iter++) {
                notes.forEach((freq, i) => {
                    const noteStartTime = now + iter * sequenceDuration + i * noteDuration;
                    if (noteStartTime >= now + playDuration) return;
                    
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = freq;
                    
                    gain.gain.setValueAtTime(0, noteStartTime);
                    gain.gain.linearRampToValueAtTime(0.2, noteStartTime + 0.05);
                    
                    const stopTime = Math.min(noteStartTime + noteDuration, now + playDuration);
                    gain.gain.exponentialRampToValueAtTime(0.001, stopTime);
                    
                    osc.connect(gain);
                    gain.connect(masterGain);
                    
                    osc.start(noteStartTime);
                    osc.stop(stopTime);
                    
                    if (startTime !== null) scheduledAudioNodes.push(osc);
                });
            }
        } else if (type === 'retro') {
            // Retro Success: Fast ascending 8-bit arpeggio
            const notes = [440, 554.37, 659.25, 880, 1108.73, 1318.51];
            const noteDuration = 0.1;
            const sequenceDuration = notes.length * noteDuration;
            const iterations = Math.ceil(playDuration / sequenceDuration);
            
            for (let iter = 0; iter < iterations; iter++) {
                notes.forEach((freq, i) => {
                    const noteStartTime = now + iter * sequenceDuration + i * noteDuration;
                    if (noteStartTime >= now + playDuration) return;
                    
                    const osc = audioCtx.createOscillator();
                    const gain = audioCtx.createGain();
                    osc.type = 'square';
                    osc.frequency.value = freq;
                    
                    gain.gain.setValueAtTime(0.1, noteStartTime);
                    
                    const stopTime = Math.min(noteStartTime + noteDuration, now + playDuration);
                    gain.gain.setValueAtTime(0, stopTime - 0.01);
                    
                    osc.connect(gain);
                    gain.connect(masterGain);
                    
                    osc.start(noteStartTime);
                    osc.stop(stopTime);
                    
                    if (startTime !== null) scheduledAudioNodes.push(osc);
                });
            }
        } else if (type === 'urgent') {
            // Urgent Pulse: Alternating high-low dual-tone siren
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'square';
            
            const pulseRate = 0.3;
            const iterations = Math.ceil(playDuration / pulseRate);
            
            for (let i = 0; i < iterations; i++) {
                const noteStartTime = now + i * pulseRate;
                if (noteStartTime >= now + playDuration) break;
                const freq = i % 2 === 0 ? 880 : 660;
                osc.frequency.setValueAtTime(freq, noteStartTime);
            }
            
            gain.gain.setValueAtTime(0.1, now);
            gain.gain.linearRampToValueAtTime(0.001, now + playDuration);
            
            osc.connect(gain);
            gain.connect(masterGain);
            
            osc.start(now);
            osc.stop(now + playDuration);
            
            if (startTime !== null) scheduledAudioNodes.push(osc);
        }
    }

    function playPreAlert() {
        const typeSelect = document.getElementById('prealert-sound');
        const melodyType = typeSelect ? typeSelect.value : 'chime';
        playMelody(melodyType, null); // startTime is null for instantaneous preview
    }

    // UPDATED: Accepts startTime for scheduling
    function playTick(startTime = null) {
        initAudio();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const now = startTime !== null ? startTime : audioCtx.currentTime;
        
        osc.type = 'square';
        osc.frequency.setValueAtTime(1000, now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        
        osc.connect(gain);
        gain.connect(masterGain);
        
        osc.start(now);
        osc.stop(now + 0.05);
        
        if (startTime !== null) scheduledAudioNodes.push(osc);
    }

    function playFinalAlarm(isPreview = false) {
        const enableMainAlarm = document.getElementById('enable-main-alarm');
        if (!isPreview && enableMainAlarm && !enableMainAlarm.checked) return;

        const durationInput = document.getElementById('alarm-duration');
        const duration = durationInput ? (parseInt(durationInput.value) || 4) : 4;
        
        const typeSelect = document.getElementById('main-alarm-sound');
        const melodyType = typeSelect ? typeSelect.value : 'urgent';
        
        playMelody(melodyType, duration); // startTime is null for instantaneous preview
    }

    // NEW: Pre-Scheduling Function
    function scheduleTimerAudio(currentTimer) {
        initAudio();
        cancelScheduledAudio(); // Ensure clean slate before scheduling new audio

        const now = audioCtx.currentTime;
        const remainingSeconds = currentTimer.remaining;
        
        // 1. Pre-alert logic
        const elFocusPre = document.getElementById('enable-focus-prealert');
        const elRestPre = document.getElementById('enable-rest-prealert');
        const elFocusPreTime = document.getElementById('focus-prealert-time');
        const elRestPreTime = document.getElementById('rest-prealert-time');
        
        const focusPreAlertEnabled = elFocusPre ? elFocusPre.checked : false;
        const restPreAlertEnabled = elRestPre ? elRestPre.checked : false;
        
        const focusPreAlertTime = elFocusPreTime ? (parseInt(elFocusPreTime.value) || 30) : 30;
        const restPreAlertTime = elRestPreTime ? (parseInt(elRestPreTime.value) || 30) : 30;

        const isFocus = currentTimer.type === 'work';
        const isRest = currentTimer.type === 'rest';
        
        const preAlertEnabled = (isFocus && focusPreAlertEnabled) || (isRest && restPreAlertEnabled);
        const preAlertTime = isFocus ? focusPreAlertTime : restPreAlertTime;

        if (preAlertEnabled && remainingSeconds > preAlertTime) {
            const timeUntilPreAlert = remainingSeconds - preAlertTime;
            const typeSelect = document.getElementById('prealert-sound');
            const melodyType = typeSelect ? typeSelect.value : 'chime';
            playMelody(melodyType, null, now + timeUntilPreAlert);
        }

        // 2. Ticks logic (10 down to 1)
        for (let i = 10; i > 0; i--) {
            if (remainingSeconds > i) {
                const timeUntilTick = remainingSeconds - i;
                playTick(now + timeUntilTick);
            }
        }

        // 3. Final Alarm logic
        const enableMainAlarm = document.getElementById('enable-main-alarm');
        if (enableMainAlarm && enableMainAlarm.checked) {
            const durationInput = document.getElementById('alarm-duration');
            const duration = durationInput ? (parseInt(durationInput.value) || 4) : 4;
            const typeSelect = document.getElementById('main-alarm-sound');
            const melodyType = typeSelect ? typeSelect.value : 'urgent';
            
            playMelody(melodyType, duration, now + remainingSeconds);
        }
    }

    function formatTime(totalSeconds) {
        const m = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
        const s = (totalSeconds % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    }

    function updateGlobalControls() {
        if (!btnToggleSeq) return;
        if (timers.length === 0) {
            btnToggleSeq.disabled = true;
            btnToggleSeq.innerHTML = 'Adicione um timer';
            return;
        }
        btnToggleSeq.disabled = false;
        if (isSequenceRunning) {
            btnToggleSeq.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px; vertical-align: middle;"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg> Pausar Sequência';
        } else {
            btnToggleSeq.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px; vertical-align: middle;"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Iniciar Sequência';
        }
    }

    function renderTimers() {
        if (!container) return;
        container.innerHTML = '';
        timers.forEach((timer, index) => {
            const percentage = (timer.remaining / timer.total) * 100;
            const isFinished = timer.remaining === 0;
            const isActive = index === currentTimerIndex;
            const isRunningNow = isActive && isSequenceRunning;

            const card = document.createElement('div');
            card.className = `card timer-card type-${timer.type} ${isActive ? 'active' : ''} ${isRunningNow ? 'running' : ''}`;
            
            card.innerHTML = `
                <div class="timer-badge">${timer.type === 'work' ? 'Trabalho' : 'Descanso'}</div>
                <h3 class="card-title" style="margin-bottom: 0;">${timer.name}</h3>
                <div class="timer-display ${isFinished ? 'finished' : ''}">${formatTime(timer.remaining)}</div>
                
                <div class="timer-controls">
                    <button class="btn-icon" onclick="toggleTimer(${timer.id})" title="${isRunningNow ? 'Pausar' : 'Iniciar a partir daqui'}">
                        ${isRunningNow 
                            ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>' 
                            : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'}
                    </button>
                    <button class="btn-icon" onclick="resetTimer(${timer.id})" title="Reiniciar este timer">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><polyline points="3 3 3 8 8 8"></polyline></svg>
                    </button>
                    <button class="btn-icon danger" onclick="deleteTimer(${timer.id})" title="Excluir">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                    </button>
                </div>
                <div class="timer-progress-bar">
                    <div class="timer-progress-fill" style="width: ${percentage}%"></div>
                </div>
            `;
            container.appendChild(card);
        });
    }

    // UPDATED: Cleaned up tick() function
    function tick() {
        if (timers.length === 0) return;
        let current = timers[currentTimerIndex];
        
        if (targetEndTime === null) {
            targetEndTime = Date.now() + current.remaining * 1000;
        }

        let newRemaining = Math.ceil((targetEndTime - Date.now()) / 1000);
        if (newRemaining < 0) newRemaining = 0;
        
        current.remaining = newRemaining;
        renderTimers();

        // Audio triggering logic removed from here, now handled by scheduleTimerAudio()

        if (current.remaining <= 0) {
            clearInterval(sequenceInterval);
            targetEndTime = null;
            
            const durationInput = document.getElementById('alarm-duration');
            const duration = durationInput ? (parseInt(durationInput.value) || 4) : 4;
            
            setTimeout(() => {
                current.remaining = current.total;
                currentTimerIndex++;
                if (currentTimerIndex >= timers.length) {
                    currentTimerIndex = 0; // Loop back to start
                }
                resetTimerState();
                if (isSequenceRunning) {
                    targetEndTime = Date.now() + timers[currentTimerIndex].remaining * 1000;
                    sequenceInterval = setInterval(tick, 200);
                    renderTimers();
                    manageBrownNoiseState();
                    scheduleTimerAudio(timers[currentTimerIndex]); // NEW: Schedule next timer's audio
                } else {
                    manageBrownNoiseState();
                }
            }, duration * 1000); // delay before switching to next to match alarm
        }
    }

    window.toggleTimer = (id) => {
        initAudio();
        const index = timers.findIndex(t => t.id === id);
        if (index === -1) return;

        if (isSequenceRunning && currentTimerIndex === index) {
            // Pause
            isSequenceRunning = false;
            clearInterval(sequenceInterval);
            targetEndTime = null;
            disableKeepAlive();
            cancelScheduledAudio(); // NEW: Cancel audio on pause
        } else {
            // Start from this timer
            isSequenceRunning = true;
            if (currentTimerIndex !== index) {
                currentTimerIndex = index;
                resetTimerState();
            }
            targetEndTime = Date.now() + timers[currentTimerIndex].remaining * 1000;
            clearInterval(sequenceInterval);
            sequenceInterval = setInterval(tick, 200);
            enableKeepAlive();
            scheduleTimerAudio(timers[currentTimerIndex]); // NEW: Schedule audio on start
        }
        manageBrownNoiseState();
        renderTimers();
        updateGlobalControls();
    };

    window.resetTimer = (id) => {
        const index = timers.findIndex(t => t.id === id);
        if (index === -1) return;
        timers[index].remaining = timers[index].total;
        if (currentTimerIndex === index) {
            resetTimerState();
            if (isSequenceRunning) {
                isSequenceRunning = false;
                clearInterval(sequenceInterval);
                targetEndTime = null;
                disableKeepAlive();
                cancelScheduledAudio(); // NEW: Cancel audio on reset
            }
        }
        manageBrownNoiseState();
        renderTimers();
        updateGlobalControls();
    };

    window.deleteTimer = (id) => {
        const index = timers.findIndex(t => t.id === id);
        if (index === -1) return;
        
        timers.splice(index, 1);
        
        if (timers.length === 0) {
            isSequenceRunning = false;
            clearInterval(sequenceInterval);
            targetEndTime = null;
            currentTimerIndex = 0;
            resetTimerState();
            disableKeepAlive();
            cancelScheduledAudio(); // NEW: Cancel audio on delete
        } else if (currentTimerIndex === index) {
            isSequenceRunning = false;
            clearInterval(sequenceInterval);
            targetEndTime = null;
            if (currentTimerIndex >= timers.length) {
                currentTimerIndex = 0;
            }
            resetTimerState();
            disableKeepAlive();
            cancelScheduledAudio(); // NEW: Cancel audio on delete
        } else if (currentTimerIndex > index) {
            currentTimerIndex--;
        }
        manageBrownNoiseState();
        renderTimers();
        updateGlobalControls();
    };

    if (btnToggleSeq) {
        btnToggleSeq.addEventListener('click', () => {
            initAudio();
            if (timers.length === 0) return;
            if (isSequenceRunning) {
                isSequenceRunning = false;
                clearInterval(sequenceInterval);
                targetEndTime = null;
                disableKeepAlive();
                cancelScheduledAudio(); // NEW: Cancel audio on pause
            } else {
                isSequenceRunning = true;
                targetEndTime = Date.now() + timers[currentTimerIndex].remaining * 1000;
                clearInterval(sequenceInterval);
                sequenceInterval = setInterval(tick, 200);
                enableKeepAlive();
                scheduleTimerAudio(timers[currentTimerIndex]); // NEW: Schedule audio on start
            }
            manageBrownNoiseState();
            renderTimers();
            updateGlobalControls();
        });
    }

    if (btnResetSeq) {
        btnResetSeq.addEventListener('click', () => {
            isSequenceRunning = false;
            clearInterval(sequenceInterval);
            targetEndTime = null;
            currentTimerIndex = 0;
            resetTimerState();
            timers.forEach(t => t.remaining = t.total);
            disableKeepAlive();
            cancelScheduledAudio(); // NEW: Cancel audio on reset
            manageBrownNoiseState();
            renderTimers();
            updateGlobalControls();
        });
    }

    if (form) {
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('timer-name').value;
            const type = document.getElementById('timer-type').value;
            const minutes = parseInt(document.getElementById('timer-minutes').value) || 0;
            const seconds = parseInt(document.getElementById('timer-seconds').value) || 0;
            
            const totalSeconds = (minutes * 60) + seconds;
            if (totalSeconds <= 0) return;

            const newTimer = {
                id: Date.now(),
                name,
                type,
                total: totalSeconds,
                remaining: totalSeconds
            };

            timers.push(newTimer);
            form.reset();
            document.getElementById('timer-type').value = type === 'work' ? 'rest' : 'work'; // Auto-toggle type for convenience
            document.getElementById('timer-minutes').value = type === 'work' ? "10" : "50"; // Auto-suggest times
            document.getElementById('timer-seconds').value = "0";
            renderTimers();
            updateGlobalControls();
        });
    }

    // Initial render
    renderTimers();
    updateGlobalControls();

    const volumeSlider = document.getElementById('global-volume');
    const volumeValue = document.getElementById('volume-value');
    if (volumeSlider && volumeValue) {
        volumeSlider.addEventListener('input', (e) => {
            volumeValue.textContent = `${e.target.value}%`;
            if (masterGain) {
                masterGain.gain.value = parseInt(e.target.value) / 100;
            }
        });
    }

    const enableBrownNoiseCheckbox = document.getElementById('enable-brown-noise');
    if (enableBrownNoiseCheckbox) {
        enableBrownNoiseCheckbox.addEventListener('change', () => {
            manageBrownNoiseState();
        });
    }

    const brownNoiseVolumeSlider = document.getElementById('brown-noise-volume');
    const brownNoiseVolumeValue = document.getElementById('brown-noise-volume-value');
    if (brownNoiseVolumeSlider && brownNoiseVolumeValue) {
        brownNoiseVolumeSlider.addEventListener('input', (e) => {
            brownNoiseVolumeValue.textContent = `${e.target.value}%`;
            if (brownNoiseGain) {
                brownNoiseGain.gain.value = parseInt(e.target.value) / 100;
            }
        });
    }

    const btnPreviewPrealert = document.getElementById('btn-preview-prealert');
    if (btnPreviewPrealert) {
        btnPreviewPrealert.addEventListener('click', () => {
            playPreAlert();
        });
    }

    const btnPreviewAlarm = document.getElementById('btn-preview-alarm');
    if (btnPreviewAlarm) {
        btnPreviewAlarm.addEventListener('click', () => {
            playFinalAlarm(true);
        });
    }
});
