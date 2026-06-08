const socket = io();

let myPhone = "", myUsername = "", myKeys = null, selectedTarget = "", selectedUsername = "";
let allConversations = {}, unreadCounts = {}, allRemarks = {}, isEditing = false, editMsgId = null;
let myBlockedUsers = [];
let forgotFlowData = { phone: "", otp: ""};
let isLoadingOfflineMessages = false;

window.allUsers = [];

// ====================== INDEXED-DB (UNLIMITED STORAGE) ======================
const dbName = "SecureChatDB", storeName = "chatHistory", remarkStore = "chatRemarks";

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 2); 
        request.onupgradeneeded = (e) => {
            let db = e.target.result;
            if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
            if (!db.objectStoreNames.contains(remarkStore)) db.createObjectStore(remarkStore);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveHistory() {
    if (!myPhone) return;
    const db = await openDB();
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(allConversations, `history_${myPhone}`);
}

async function loadHistoryFromDB(phone) {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(`history_${phone}`);
        req.onsuccess = () => resolve(req.result || {});
        req.onerror = () => resolve({});
    });
}

// ====================== REMARK / ALIAS / BLOCK LOGIC ======================

async function loadRemarks() {
    const db = await openDB();
    return new Promise((resolve) => {
        const tx = db.transaction(remarkStore, "readonly");
        const request = tx.objectStore(remarkStore).get(`remarks_${myPhone}`);
        request.onsuccess = () => {
            allRemarks = request.result || {};
            resolve();
        };
        request.onerror = () => resolve();
    });
}

function getDisplayName(phone, originalUsername) {
    return allRemarks[phone] || originalUsername || "Unknown User";
}

function openContactInfo() {
    document.getElementById("info-phone").value = selectedTarget;
    document.getElementById("info-username").value = selectedUsername;
    document.getElementById("info-remark").value = allRemarks[selectedTarget] || "";
    
    // Update Block Button UI
    const blockBtn = document.querySelector("button[onclick='blockUser()']");
    if (myBlockedUsers.includes(selectedTarget)) {
        blockBtn.innerText = "Unblock User";
        blockBtn.className = "btn btn-success w-100"; // Green for unblock
    } else {
        blockBtn.innerText = "Block User";
        blockBtn.className = "btn btn-danger w-100"; // Red for block
    }
    
    document.getElementById("modal-contact-info").classList.remove("hidden");
}

function closeContactInfo() {
    document.getElementById("modal-contact-info").classList.add("hidden");
}

async function saveRemark() {
    const remark = document.getElementById("info-remark").value.trim();
    const phone = document.getElementById("info-phone").value;

    if (remark) {
        const duplicatePhone = Object.keys(allRemarks).find(p =>
            p !== phone &&
            allRemarks[p].toLowerCase() === remark.toLowerCase()
        );

        if (duplicatePhone) {
            return alert("This remark name is already used. Please use a different name.");
        }

        allRemarks[phone] = remark;
    } else {
        delete allRemarks[phone];
    }

    const db = await openDB();
    const tx = db.transaction(remarkStore, "readwrite");
    tx.objectStore(remarkStore).put(allRemarks, `remarks_${myPhone}`);
    
    alert("Remark saved!");
    closeContactInfo();
    document.getElementById("chat-target-name").innerText = getDisplayName(phone, selectedUsername);
    renderUserList();
}

async function fetchBlockedUsers() {
    const res = await fetch(`/get_blocks/${myPhone}`);
    const d = await res.json();
    myBlockedUsers = d.blockedUsers || [];
}

async function blockUser() {
    const target = selectedTarget;
    const res = await fetch("/toggle_block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ myPhone: myPhone, targetPhone: target })
    });
    
    const d = await res.json();
    
    if (d.status === "blocked") {
        myBlockedUsers.push(target); // Add to local list
        alert("User Blocked.");
    } else {
        myBlockedUsers = myBlockedUsers.filter(p => p !== target); // Remove from local list
        alert("User Unblocked.");
    }
    
    closeContactInfo();
    renderUserList();
}

// ====================== SESSION & INIT ======================

async function saveSession(phone, keys, username) {
    sessionStorage.setItem("chat_activePhone", phone);
    sessionStorage.setItem("chat_myUsername", username);
    if (keys) {
        const pub = await crypto.subtle.exportKey("jwk", keys.publicKey);
        const priv = await crypto.subtle.exportKey("jwk", keys.privateKey);
        localStorage.setItem(`chat_keys_${phone}`, JSON.stringify({ publicKey: pub, privateKey: priv }));
    }
}

async function checkExistingSession() {
    const phone = sessionStorage.getItem("chat_activePhone");
    const user = sessionStorage.getItem("chat_myUsername");

    if (!phone || !user) {
        showPage("page-login");
        return;
    }

    let keyData = localStorage.getItem(`chat_keys_${phone}`);

    if (!keyData) {
        myKeys = await crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256"
            },
            true,
            ["encrypt", "decrypt"]
        );

        await saveSession(phone, myKeys, user);

        keyData = localStorage.getItem(`chat_keys_${phone}`);
    }

    try {
        const parsed = JSON.parse(keyData);

        myKeys = {
            publicKey: await crypto.subtle.importKey(
                "jwk",
                parsed.publicKey,
                { name: "RSA-OAEP", hash: "SHA-256" },
                true,
                ["encrypt"]
            ),
            privateKey: await crypto.subtle.importKey(
                "jwk",
                parsed.privateKey,
                { name: "RSA-OAEP", hash: "SHA-256" },
                true,
                ["decrypt"]
            )
        };

        myPhone = phone;
        myUsername = user;

        allConversations = await loadHistoryFromDB(myPhone);
        await loadRemarks();

        document.getElementById("display-my-username").innerText = myUsername;
        showPage("page-chat");

        socket.emit("join", myPhone);
        loadUsers();
        await fetchOfflineMessages();
        addKeyboardSupport();
        await fetchBlockedUsers();

    } catch (e) {
        console.error(e);
        showPage("page-login");
    }
}

function logout() { sessionStorage.clear(); location.reload(); }

// ====================== PROFILE UPDATES ======================

function openProfile() {
    document.getElementById("edit-username").value = myUsername;
    document.getElementById("edit-phone").value = myPhone;
    showPage("page-profile");
}

async function updateProfile() {
    const newName = document.getElementById("edit-username").value.trim();
    const newPhone = document.getElementById("edit-phone").value.trim();
    
    const oldPass = document.getElementById("edit-old-pass").value;
    const newPass = document.getElementById("edit-new-pass").value;
    const confirmPass = document.getElementById("edit-confirm-pass").value;

    // 1. Basic Validation
    if (!newName || !newPhone) return alert("Username and Phone cannot be empty.");

    // 2. Username Regex (3-20 chars, alphanumeric)
    const userRegex = /^[a-zA-Z0-9_ ]{3,20}$/;
    if (!userRegex.test(newName)) {
        return alert("Username must be 3-20 characters (letters, numbers, underscores).");
    }

    // 3. Phone Regex (10-11 digits)
    const phoneRegex = /^(011\d{8}|01[023456789]\d{7})$/;
    if (!phoneRegex.test(newPhone)) {
        return alert("Phone number must be 10 or 11 digits.");
    }

    // 4. Password Validation (Only if user typed something in password boxes)
    if (newPass || oldPass || confirmPass) {
        if (!oldPass) return alert("You must enter your Current Password to set a new one.");
        if (newPass !== confirmPass) return alert("New passwords do not match.");
        
        // Password Strength Regex
        const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&._-])[A-Za-z\d@$!%*?&._-]{8,}$/;
        if (!passRegex.test(newPass)) {
            return alert("New password is too weak! Must be 8+ chars with Upper, Lower, Number, and Symbol.");
        }
    }

    // --- ALL VALIDATION PASSED ---
    const res = await fetch("/update_profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            oldPhone: myPhone,
            newPhone: newPhone,
            username: newName,
            oldPassword: oldPass,
            newPassword: newPass
        })
    });

    const d = await res.json();
    if (!res.ok) return alert(d.message || "Update failed.");

    // --- MIGRATION LOGIC (Keys & History) ---
    if (newPhone !== myPhone) {
        const keys = localStorage.getItem(`chat_keys_${myPhone}`);
        localStorage.setItem(`chat_keys_${newPhone}`, keys);
        localStorage.removeItem(`chat_keys_${myPhone}`);

        const db = await openDB();
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        
        // Move history to the new ID folder
        if (allConversations) {
            store.put(allConversations, `history_${newPhone}`);
            store.delete(`history_${myPhone}`);
        }
    }

    // Update session storage
    sessionStorage.setItem("chat_activePhone", newPhone);
    sessionStorage.setItem("chat_myUsername", newName);
    
    alert("Profile updated successfully!");
    location.reload();
}

async function deactivateAccount() {
    if (!confirm("Delete account and all history forever?")) return;
    await fetch("/deactivate_account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: myPhone }) });
    localStorage.removeItem(`chat_keys_${myPhone}`);
    logout();
}

// ====================== MESSAGING & E2EE ======================

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += 8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8000));
    return btoa(binary);
}

async function decryptPayload(payload) {
    try {
        const decAes = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, myKeys.privateKey, Uint8Array.from(atob(payload.aesKey), c => c.charCodeAt(0)));
        const aesObj = await crypto.subtle.importKey("raw", decAes, { name: "AES-GCM" }, false, ["decrypt"]);
        const decCon = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(payload.iv), c => c.charCodeAt(0)) }, aesObj, Uint8Array.from(atob(payload.data), c => c.charCodeAt(0)));
        return new TextDecoder().decode(decCon);
    } catch (e) { return null; }
}

async function sendEncrypted(mediaData = null, mediaType = "text") {
    const input = document.getElementById("msg-input");
    const content = mediaData || input.value;
    if (!selectedTarget || (!mediaData && (!content || content.trim() === ""))) {alert("Message cannot be empty."); return; }
    if (isEditing && !mediaData) { performEdit(content); return; }
    if (myBlockedUsers.includes(selectedTarget)) {
        alert(`You have blocked this user. You must unblock them before you can send a message.`);
        return; }

    try {
        const res = await fetch(`/get_key/${selectedTarget}`);
        const k = await res.json();
        const startEncrypt = performance.now();
        const pubKey = await crypto.subtle.importKey("spki", Uint8Array.from(atob(k.publicKey), c => c.charCodeAt(0)), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encC = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(content));
        const encA = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, await crypto.subtle.exportKey("raw", aes));
        const msgId = Date.now().toString() + Math.random().toString().slice(2, 8);
        const timestamp = new Date().toISOString();
        const payload = { aesKey: arrayBufferToBase64(encA), iv: arrayBufferToBase64(iv), data: arrayBufferToBase64(encC), mediaType, msgId, timestamp };
        const endEncrypt = performance.now();
        console.log("Encryption Time:", (endEncrypt - startEncrypt).toFixed(2), "ms");

        socket.emit("chat_message", { sender: myPhone, recipient: selectedTarget, payload });
        if (!allConversations[selectedTarget]) allConversations[selectedTarget] = [];
        allConversations[selectedTarget].push({ text: content, type: "sent", mediaType, msgId, timestamp });
        if (!mediaData) input.value = "";
        await saveHistory(); refreshChatWindow();
    } catch (e) { console.error(e); }
}

async function performEdit(newText) {
    try {
        const res = await fetch(`/get_key/${selectedTarget}`);
        const k = await res.json();
        const pubKey = await crypto.subtle.importKey("spki", Uint8Array.from(atob(k.publicKey), c => c.charCodeAt(0)), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
        const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encC = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(newText));
        const encA = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKey, await crypto.subtle.exportKey("raw", aes));
        const newPayload = { aesKey: arrayBufferToBase64(encA), iv: arrayBufferToBase64(iv), data: arrayBufferToBase64(encC), mediaType: "text", msgId: editMsgId, isEdited: true };
        socket.emit("edit_message", { msgId: editMsgId, newPayload, sender: myPhone, recipient: selectedTarget });
        const idx = allConversations[selectedTarget].findIndex(m => m.msgId === editMsgId);
        if (idx !== -1) {allConversations[selectedTarget][idx].text = newText;allConversations[selectedTarget][idx].isEdited = true;}
        isEditing = false; editMsgId = null; document.getElementById("msg-input").value = ""; document.getElementById("send-btn").innerText = "Send";
        await saveHistory(); refreshChatWindow();
    } catch (e) { console.error(e); }
}

function deleteMessage(msgId) {
    const msgs = allConversations[selectedTarget];
    const idx = msgs.findIndex(m => m.msgId === msgId);
    if (idx === -1) return;

    const message = msgs[idx];
    const isSentByMe = (message.type === "sent");

    if (isSentByMe) {
        if (!confirm("Delete for everyone?")) return;
        // 1. Change to "Deleted" marker locally
        msgs[idx] = { msgId: msgId, isDeleted: true, type: "sent" };
        socket.emit("delete_message", { msgId, sender: myPhone, recipient: selectedTarget, mode: "everyone" });
    } else {
        if (!confirm("Delete for me?")) return;
        // 2. Simply remove from screen locally
        msgs.splice(idx, 1);
        socket.emit("delete_message", { msgId, sender: myPhone, recipient: selectedTarget, mode: "me" });
    }

    saveHistory();
    refreshChatWindow();
}

async function deleteConversation(phone) {

    if (!confirm("Delete this chat permanently from your chat list?")) {
        return;
    }
    delete allConversations[phone];
    delete unreadCounts[phone];
    closeContactInfo();
    if (selectedTarget === phone) {
        selectedTarget = "";
        selectedUsername = "";
        document.getElementById("chat-target-name").innerText = "";
        document.getElementById("chat-header").classList.add("hidden");
        document.getElementById("input-area").classList.add("hidden");
        document.getElementById("empty-state").classList.remove("hidden");
        document.getElementById("message-pane").innerHTML = "";
    }
    await saveHistory();
    renderUserList();
}

function startEdit(msgId, oldText) { 
    isEditing = true; editMsgId = msgId; 
    document.getElementById("msg-input").value = oldText.replace(" (edited)", ""); 
    document.getElementById("msg-input").focus(); 
    document.getElementById("send-btn").innerText = "Update"; 
}

function copyText(text) { navigator.clipboard.writeText(text.replace(" (edited)", "")); alert("Copied!"); }

// ====================== UI & RECEIVE ======================

async function processIncomingMessage(data) {
    if (String(data.sender) === String(myPhone)) return;
    const payload = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload;

    if (payload.timestamp) {
    const sentTime = new Date(payload.timestamp).getTime();
    const receivedTime = new Date().getTime();
    console.log("Message Delivery Time:", receivedTime - sentTime, "ms");
    }
    if (payload.isDeleted) return; 
    const message = await decryptPayload(payload); if (!message) return;
    if (!allConversations[data.sender]) allConversations[data.sender] = [];
    if (!allConversations[data.sender].some(m => m.msgId === payload.msgId)) {
        allConversations[data.sender].push({ text: message, type: "received", mediaType: payload.mediaType, msgId: payload.msgId, timestamp: payload.timestamp});
        await saveHistory(); if (String(selectedTarget) !== String(data.sender)) unreadCounts[data.sender] = (unreadCounts[data.sender] || 0) + 1;
    }
    if (String(selectedTarget) === String(data.sender)) refreshChatWindow();
        renderUserList();

        const senderUser =
        window.allUsers.find(
            u => String(u.phone) === String(data.sender)
        );

    const senderName =
        senderUser?.username || data.sender;

    if (
        !isLoadingOfflineMessages &&
        "Notification" in window &&
        Notification.permission === "granted"
    ) {
        const notification = new Notification(senderName, {
            body: "New message received",
            icon: "/static/images/chipchat.png"
        });

        notification.onclick = function () {
            window.focus();
        };
    }
}

async function fetchOfflineMessages() {
    isLoadingOfflineMessages = true;

    try {
        const res = await fetch(`/fetch_messages/${myPhone}`);
        const d = await res.json();

        if (d.messages) {
            for (let m of d.messages) {
                if (String(m.recipient) === String(myPhone)) {
                    await processIncomingMessage(m);
                }
            }
        }
    } finally {
        isLoadingOfflineMessages = false;
    }
}

function renderUserList() {
    const l = document.getElementById("user-list"); 
    if (!l) return; 
    l.innerHTML = "";

    const searchBox = document.getElementById("user-search");
    const term = searchBox ? searchBox.value.trim() : "";

    let shownCount = 0;

    window.allUsers.forEach(u => {
        if (String(u.phone) === String(myPhone)) return;

        const phoneNumber = String(u.phone);
        const displayName = getDisplayName(u.phone, u.username).toLowerCase();
        const searchTerm = term.toLowerCase();

        const hasHistory =
            allConversations[u.phone] &&
            allConversations[u.phone].length > 0;

        let shouldShow = false;

        if (term === "") {
            shouldShow = hasHistory;
        } else {
            if (hasHistory) {
                shouldShow =
                    phoneNumber.includes(term) ||
                    displayName.includes(searchTerm);
            } else {
                shouldShow = phoneNumber === term;
            }
        }

        if (!shouldShow) return;

        const d = document.createElement("div");
        d.className = "user-item" + (selectedTarget === u.phone ? " active-user" : "");

        d.innerHTML = `<div><strong>${getDisplayName(u.phone, u.username)}</strong></div>`;

        if (unreadCounts[u.phone]) { 
            const b = document.createElement("span"); 
            b.className = "unread-badge"; 
            b.innerText = unreadCounts[u.phone]; 
            d.appendChild(b); 
        }

        d.onclick = () => selectRecipient(u.phone, u.username);
        l.appendChild(d);
        shownCount++;
    });

    if (shownCount === 0) {
        if (window.innerWidth <= 600 && term === "") {

                l.innerHTML = `
                    <div class="empty-user-list">
                        <img src="/static/images/chipchat.png" alt="ChipChat">
                        <p>End-to-End Encrypted Messaging</p>
                        <small>Search a phone number to start chatting</small></div>`;
            } else if (term === "") {
                l.innerHTML = `
                    <div class="text-muted small p-3">No conversations yet.</div>`;
            } else {
                l.innerHTML = `<div class="text-muted small p-3">No registered user found.</div>`;
            }
        }
}

function clearSearch() {
    document.getElementById("user-search").value = "";
    renderUserList();
}

function selectRecipient(p, name) { 
    selectedTarget = p; 
    selectedUsername = name; 
    unreadCounts[p] = 0; 
    
    document.getElementById("chat-target-name").innerText = getDisplayName(p, name); 
    document.getElementById("empty-state").classList.add("hidden"); 
    document.getElementById("chat-header").classList.remove("hidden"); 
    document.getElementById("input-area").classList.remove("hidden"); 

    // Mobile: after selecting user, hide sidebar and show full chat
    if (window.innerWidth <= 768) {
        document.getElementById("page-chat").classList.add("mobile-chat-open");
    }
    renderUserList(); 
    refreshChatWindow(); 
}

function backToUserList() {
    if (window.innerWidth <= 768) {
        document.getElementById("page-chat").classList.remove("mobile-chat-open");

        selectedTarget = "";
        selectedUsername = "";

        document.getElementById("chat-target-name").innerText = "";
        document.getElementById("chat-header").classList.add("hidden");
        document.getElementById("input-area").classList.add("hidden");
        document.getElementById("empty-state").classList.remove("hidden");
        document.getElementById("message-pane").innerHTML = "";

        renderUserList();
    }
}

function refreshChatWindow() {

    const p = document.getElementById("message-pane");
    p.innerHTML = "";

    let lastDate = "";

    (allConversations[selectedTarget] || []).forEach(m => {

        // ===== WhatsApp-style Date Divider =====
        if (m.timestamp) {
            const msgDate = new Date(m.timestamp);

            const today = new Date();

            const yesterday = new Date();
            yesterday.setDate(today.getDate() - 1);

            let dateLabel = "";

            if (msgDate.toDateString() === today.toDateString()) {
                dateLabel = "Today";
            } 
            else if (msgDate.toDateString() === yesterday.toDateString()) {
                dateLabel = "Yesterday";
            } 
            else {
                dateLabel = msgDate.toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "long",
                    year: "numeric"
                });
            }

            if (dateLabel !== lastDate) {
                const divider = document.createElement("div");
                divider.className = "date-divider";
                divider.innerHTML = `<span>${dateLabel}</span>`;
                p.appendChild(divider);

                lastDate = dateLabel;
            }
        }

        const d = document.createElement("div");
        d.className = "msg " + (m.type === "sent" ? "msg-sent" : "msg-received");

        if (m.isDeleted) {
            d.innerHTML = `<i style="opacity:0.5;font-size:13px;">🚫 This message was deleted</i>`;
        } else {
            if (m.mediaType === "audio") {
                const a = document.createElement("audio");
                a.src = m.text;
                a.controls = true;
                d.appendChild(a);
            } 
            else if (m.mediaType === "image") {
                const i = document.createElement("img");
                i.src = m.text;
                i.onclick = () => i.classList.toggle("img-big");
                d.appendChild(i);
            } 
            else if (m.mediaType === "video") {
                const v = document.createElement("video");
                v.src = m.text;
                v.controls = true;
                d.appendChild(v);
            } 
            else {
                const text = document.createElement("span");
                text.innerText = m.text;
                d.appendChild(text);
            }

            const meta = document.createElement("div");
            meta.className = "msg-meta";

            let timeText = "";
            if (m.timestamp) {
                timeText = new Date(m.timestamp).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit"
                });
            }

            meta.innerHTML = timeText + (m.isEdited ? " · edited" : "");
            d.appendChild(meta);

            const menu = document.createElement("div");
            menu.className = "msg-menu";

            menu.innerHTML += `<span onclick="deleteMessage('${m.msgId}')">🗑️</span>`;

            if (m.type === "sent" && (!m.mediaType || m.mediaType === "text")) {
                const safeText = m.text.replace(/'/g, "\\'");
                menu.innerHTML += `<span onclick="startEdit('${m.msgId}','${safeText}')">✏️</span>`;
            }

            if (!m.mediaType || m.mediaType === "text") {
                const safeText = m.text.replace(/'/g, "\\'");
                menu.innerHTML += `<span onclick="copyText('${safeText}')">📋</span>`;
            }

            d.appendChild(menu);

            let pressTimer;

            d.addEventListener("touchstart", function(e) {
                if (
                    e.target.tagName === "AUDIO" ||
                    e.target.tagName === "VIDEO" ||
                    e.target.tagName === "IMG"
                ) return;

                pressTimer = setTimeout(() => {
                    document
                        .querySelectorAll(".msg.show-menu")
                        .forEach(x => x.classList.remove("show-menu"));

                    d.classList.add("show-menu");
                }, 800);
            });

            d.addEventListener("touchend", () => {
                clearTimeout(pressTimer);
            });

            d.addEventListener("touchmove", () => {
                clearTimeout(pressTimer);
            });
        }

        p.appendChild(d);
    });

    p.scrollTop = p.scrollHeight;
}

document.addEventListener("click", function(e) {

    if (!e.target.closest(".msg")) {

        document
            .querySelectorAll(".msg.show-menu")
            .forEach(x =>
                x.classList.remove("show-menu")
            );
    }

});

function togglePassword(id, btn) {
    const input = document.getElementById(id);

    if (input.type === "password") {
        input.type = "text";
        btn.innerText = "Hide";
    } else {
        input.type = "password";
        btn.innerText = "Show";
    }
}

// ====================== MEDIA & LISTENERS ======================

socket.on("connect", () => {
    const phone = sessionStorage.getItem("chat_activePhone");
    if (phone) socket.emit("join", phone);
});

socket.on("user_updated", async (data) => {
    const { oldPhone, newPhone, username } = data;

    // 1. Check if the phone number actually changed
    if (String(oldPhone) !== String(newPhone)) {
        console.log("Migration: Phone number changed by contact.");
        
        // If we have history for the old phone, move it to the new one
        if (allConversations[oldPhone]) {
            allConversations[newPhone] = allConversations[oldPhone];
            delete allConversations[oldPhone];
            
            // If we are currently chatting with them, update the target
            if (selectedTarget === oldPhone) {
                selectedTarget = newPhone;
                selectedUsername = username;
                document.getElementById("chat-target-name").innerText = username;
            }
            await saveHistory(); // Save moved data to IndexedDB
        }
    } else {
        // 2. Only the username changed
        console.log("Update: Contact changed their username.");
        if (selectedTarget === oldPhone) {
            selectedUsername = username;
            document.getElementById("chat-target-name").innerText = username;
        }
    }

    // Refresh UI to show new names
    loadUsers(); 
    if (selectedTarget === newPhone || selectedTarget === oldPhone) refreshChatWindow();
});

// Regular Listeners
socket.on("receive_message", d => processIncomingMessage(d));
socket.on("update_user_list", u => { window.allUsers = u; renderUserList(); });

socket.on("message_edited", async data => {
    const idx = allConversations[data.sender]?.findIndex(m => m.msgId === data.msgId);
    if (idx !== -1) { 
        const txt = await decryptPayload(data.newPayload); 
        if (txt) { allConversations[data.sender][idx].text = txt; allConversations[data.sender][idx].isEdited = true; await saveHistory(); 
        if (selectedTarget === data.sender) refreshChatWindow(); } 
    }
});

socket.on("message_deleted", data => {
    const sender = data.sender; 
    if (allConversations[sender]) {
        const idx = allConversations[sender].findIndex(m => m.msgId === data.msgId);
        if (idx !== -1) {
            // Change the message to the deleted marker on the recipient's side
            allConversations[sender][idx] = { msgId: data.msgId, isDeleted: true, type: "received" };
            saveHistory();
            if (selectedTarget === sender) refreshChatWindow();
        }
    }
});

socket.on("user_phone_changed", async (data) => {
    const { oldPhone, newPhone, username } = data;

    // 1. If we have a chat history for the old phone, move it to the new phone
    if (allConversations[oldPhone]) {
        console.log(`System: Merging history from ${oldPhone} to ${newPhone}`);
        
        // Move the data in the local variable
        allConversations[newPhone] = allConversations[oldPhone];
        delete allConversations[oldPhone];

        // 2. If the user was currently looking at the old chat, switch them to the new one
        if (selectedTarget === oldPhone) {
            selectedTarget = newPhone;
            document.getElementById("chat-target-name").innerText = username;
        }

        // 3. Save the new moved history to IndexedDB
        await saveHistory();
        
        // 4. Refresh UI
        renderUserList();
        if (selectedTarget === newPhone) refreshChatWindow();
    }
});

socket.on("force_logout", (data) => {
    alert(data.message || "You have been logged out because this account logged in on another device.");
    sessionStorage.clear();
    location.reload();
});

async function handleFileSelect(event, type) {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);
    const maxSize = 15 * 1024 * 1024; // 15MB

    for (let i = 0; i < fileArray.length; i++) {
        const file = fileArray[i];

        if (file.size > maxSize) { 
            alert(`File "${file.name}" is too large. Maximum file size is 15MB.`);
            continue; 
        }

        await new Promise((resolve) => {
            const reader = new FileReader();

            reader.onload = async (e) => {
                await sendEncrypted(e.target.result, type);
                setTimeout(resolve, 100); 
            };

            reader.readAsDataURL(file);
        });
    }
    event.target.value = "";
}

let mediaRecorder, audioChunks = [], isRecording = false, shouldSend = true;
async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream); audioChunks = [];
        mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
        mediaRecorder.onstop = async () => { 
            if (shouldSend && audioChunks.length) { 
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const r = new FileReader(); 
                r.onload = (ev) => sendEncrypted(ev.target.result, "audio"); 
                r.readAsDataURL(audioBlob); 
            } 
            stream.getTracks().forEach(t => t.stop()); 
        };
        mediaRecorder.start(); isRecording = true; setRecordingUI(true);
    } catch (err) { alert("Mic denied."); }
}
function stopRecording() { if (mediaRecorder) { shouldSend = true; mediaRecorder.stop(); isRecording = false; setRecordingUI(false); } }
function cancelRecording() { if (mediaRecorder) { shouldSend = false; mediaRecorder.stop(); isRecording = false; setRecordingUI(false); } }
function toggleVoiceRecorder() { isRecording ? stopRecording() : startRecording(); }
function setRecordingUI(rec) { 
    const vBtn = document.getElementById("voice-btn"); if(vBtn) vBtn.innerHTML = rec ? "⏹️" : "🎤";
    ["cancel-record-btn", "recording-status"].forEach(id => { const el = document.getElementById(id); if(el) el.classList.toggle("d-none", !rec); });
    ["msg-input", "send-btn", "input-dropdown"].forEach(id => { const el = document.getElementById(id); if(el) el.classList.toggle("d-none", rec); });
}

function filterUsers() { renderUserList(); }
function addKeyboardSupport() { const input = document.getElementById("msg-input"); if(input) input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendEncrypted(); } }); }
function showPage(p) { document.querySelectorAll(".container, .main-container").forEach(c => c.classList.add("hidden")); const el = document.getElementById(p); if(el) el.classList.remove("hidden"); }
async function loadUsers() { const r = await fetch("/list_users"); const d = await r.json(); window.allUsers = d.users; renderUserList(); }

async function handleAuth(type) {
    // Get basic inputs
    const phone = document.getElementById(type === "login" ? "login-phone" : "reg-phone").value.trim();
    const pass = document.getElementById(type === "login" ? "login-pass" : "reg-pass").value;

    if (type === "signup") {
        const user = document.getElementById("reg-username").value.trim();
        const confirm = document.getElementById("reg-confirm").value;

        // 1. Check for empty fields
        if (!user || !phone || !pass || !confirm) return alert("Please fill in all registration fields.");

        // 2. Validate Username (3-20 chars, alphanumeric + underscore)
        const userRegex = /^[a-zA-Z0-9_ ]{3,20}$/;
        if (!userRegex.test(user)) {
            return alert("Username must be 3-20 characters and contain only letters, numbers, or underscores.");
        }

        // 3. Validate Phone Number (10-11 digits)
        const phoneRegex = /^(011\d{8}|01[0,2-9]\d{7})$/;
        if (!phoneRegex.test(phone)) {
            return alert("Please enter a valid phone number.");
        }

        // 4. Validate Password Strength (Min 8 chars, 1 Upper, 1 Lower, 1 Number, 1 Symbol)
        const passRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&._-])[A-Za-z\d@$!%*?&._-]{8,}$/;
        if (!passRegex.test(pass)) {
            return alert("Security Alert: Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.");
        }

        // 5. Check if passwords match
        if (pass !== confirm) {
            return alert("Passwords do not match. Please re-enter.");
        }

        // --- VALIDATION PASSED: Generate RSA Keys ---
        try {
            myKeys = await crypto.subtle.generateKey(
                {
                    name: "RSA-OAEP",
                    modulusLength: 2048,
                    publicExponent: new Uint8Array([1, 0, 1]),
                    hash: "SHA-256"
                },
                true,
                ["encrypt", "decrypt"]
            );

            const pub = await crypto.subtle.exportKey("spki", myKeys.publicKey);
            
            const res = await fetch("/signup", { 
                method: "POST", 
                headers: { "Content-Type": "application/json" }, 
                body: JSON.stringify({ 
                    phone, 
                    username: user, 
                    password: pass, 
                    publicKey: arrayBufferToBase64(pub) 
                }) 
            });

            const d = await res.json();
            if (!res.ok) return alert(d.message || "Registration failed.");
            
            myUsername = user;
        } catch (err) {
            console.error("Encryption Error:", err);
            return alert("Could not generate secure keys. Please use a modern browser.");
        }

    } else {
        // --- LOGIN LOGIC ---
        if (!phone || !pass) return alert("Please enter your phone and password.");

        const res = await fetch("/login", { 
            method: "POST", 
            headers: { "Content-Type": "application/json" }, 
            body: JSON.stringify({ phone, password: pass }) 
        });

        const d = await res.json();
        if (!res.ok) return alert(d.message || "Please check the phone number and password.");

        myUsername = d.username;
    }

// Success: Set session variables and enter chat
myPhone = phone;

if (!myKeys) {
    myKeys = await crypto.subtle.generateKey(
        {
            name: "RSA-OAEP",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256"
        },
        true,
        ["encrypt", "decrypt"]
    );
}

await saveSession(myPhone, myKeys, myUsername);

const exportedKey = await crypto.subtle.exportKey("spki", myKeys.publicKey);
const publicKey = arrayBufferToBase64(exportedKey);

await fetch("/update_public_key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        phone: myPhone,
        publicKey: publicKey
    })
});

await checkExistingSession();
}

// ====================== FORGOT PASSWORD LOGIC ======================
async function sendOTP() {
    const phone = document.getElementById("forgot-phone").value.trim();
    if (!phone) return alert("Enter phone number");

    const res = await fetch("/forgot_password_send_otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone })
    });

    const data = await res.json();

    if (res.ok) {
        forgotFlowData.phone = phone;

        alert("Your OTP is: " + data.otp + "\nThis OTP will expire in 5 minutes.");

        document.getElementById("forgot-step-1").classList.add("hidden");
        document.getElementById("forgot-step-2").classList.remove("hidden");
    } else {
        alert(data.message || "User not found");
    }
}

async function verifyOTP() {
    const otp = document.getElementById("forgot-otp").value.trim();

    const res = await fetch("/forgot_password_verify_otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: forgotFlowData.phone, otp: otp })
    });

    const data = await res.json();

    if (res.ok) {
        forgotFlowData.otp = otp;
        document.getElementById("forgot-step-2").classList.add("hidden");
        document.getElementById("forgot-step-3").classList.remove("hidden");
    } else {
        alert(data.message || "Invalid OTP code.");
    }
}

async function resetPassword() {
    const newPass = document.getElementById("forgot-new-pass").value;
    const confirmPass = document.getElementById("forgot-confirm-pass").value;

    const passwordPattern = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&._-])[A-Za-z\d@$!%*?&._-]{8,}$/;

    if (!newPass || !confirmPass) {
        return alert("Please fill in both password fields");
    }

    if (!passwordPattern.test(newPass)) {
        return alert("Password must be at least 8 characters and include uppercase, lowercase, number, and special character (@$!%*?&._-).");
    }

    if (newPass !== confirmPass) {
        return alert("Passwords do not match");
    }

    const res = await fetch("/forgot_password_reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            phone: forgotFlowData.phone,
            otp: forgotFlowData.otp,
            newPassword: newPass
        })
    });

    const data = await res.json();

    if (res.ok) {
        alert("Password updated! Please login.");
        showPage("page-login");
    } else {
        alert(data.message || "Reset failed.");
    }
}

// ====================== NOTIFICATION LOGIC ======================

async function requestNotificationPermission() {
    if ("Notification" in window) {
        if (Notification.permission !== "granted") {
            await Notification.requestPermission();
        }
    }
}

window.onload = async () => {
    await requestNotificationPermission();
    checkExistingSession();
};