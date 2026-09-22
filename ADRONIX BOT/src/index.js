// src/index.js

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. Handle CORS Preflight checks (OPTIONS)
        if (request.method === "OPTIONS") {
            return corsResponse(null, 204);
        }

        // 2. Simple health check route
        if (url.pathname === "/") {
            return textResponse("ADRONIX RECORDS Discord Worker is active and running.");
        }

        // 3. Register Slash Commands Endpoint (One-click browser registration)
        if (url.pathname === "/api/register-commands") {
            return await registerCommands(env);
        }

        // 4. Automated Submission & Channel Creation Endpoint
        if (url.pathname === "/api/submit-demo") {
            if (request.method !== "POST") {
                return jsonResponse({ error: "Method Not Allowed" }, 405);
            }
            return await handleWebSubmission(request, env, ctx);
        }

        // 5. Discord Interactions Webhook (Processes Slash Commands)
        if (url.pathname === "/interactions" || url.pathname === "/api/interactions") {
            if (request.method !== "POST") {
                return jsonResponse({ error: "Method Not Allowed" }, 405);
            }

            const isValid = await verifySignature(request, env.DISCORD_PUBLIC_KEY);
            if (!isValid) {
                return jsonResponse({ error: "Invalid request signature" }, 401);
            }

            const interaction = await request.json();

            // Handle PING (Type 1) - Discord Handshake
            if (interaction.type === 1) {
                return jsonResponse({ type: 1 });
            }

            // Handle Slash Commands (Type 2)
            if (interaction.type === 2) {
                return await handleSlashCommand(interaction, env, ctx);
            }
        }

        return jsonResponse({ error: "Page not found" }, 404);
    }
};

/**
 * Robust CORS Helper functions to wrap all responses safely
 */
function corsResponse(body, status = 200, extraHeaders = {}) {
    return new Response(body, {
        status: status,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Signature-Ed25519, X-Signature-Timestamp",
            "Access-Control-Max-Age": "86400",
            ...extraHeaders
        }
    });
}

function jsonResponse(data, status = 200) {
    return corsResponse(JSON.stringify(data), status, {
        "Content-Type": "application/json"
    });
}

function textResponse(text, status = 200) {
    return corsResponse(text, status, {
        "Content-Type": "text/plain;charset=UTF-8"
    });
}

/**
 * Handles Web Form Submission (Instantly creates private channel and posts data)
 */
async function handleWebSubmission(request, env, ctx) {
    try {
        const body = await request.json();
        const { artistName, email, discordId, demoLink, spotifyUrl, genre, message, ticketCode } = body;

        if (!artistName || !email || !discordId || !demoLink) {
            return jsonResponse({ error: "Missing required fields" }, 400);
        }

        const BOT_TOKEN = env.DISCORD_BOT_TOKEN;
        const GUILD_ID = env.DISCORD_GUILD_ID;
        const CATEGORY_ID = env.DISCORD_CATEGORY_ID; 
        const STAFF_ROLE_ID = env.DISCORD_STAFF_ROLE_ID; 

        if (!BOT_TOKEN || !GUILD_ID) {
            return jsonResponse({ error: "Server missing configuration credentials" }, 500);
        }

        // 1. Establish channel permissions (Private)
        const permissionOverwrites = [
            {
                id: GUILD_ID, // Deny view access to @everyone
                type: 0,
                deny: "1024"
            }
        ];

        if (STAFF_ROLE_ID) {
            permissionOverwrites.push({ id: STAFF_ROLE_ID, type: 0, allow: "3072" });
        }

        const isNumericUserId = /^\d{17,19}$/.test(discordId);
        if (isNumericUserId) {
            permissionOverwrites.push({ id: discordId, type: 1, allow: "3072" });
        }

        // 2. Standardize Channel name
        const sanitizedArtist = artistName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const channelName = `demo-${sanitizedArtist || 'review'}`;

        // 3. Request channel creation from Discord API
        const discordResponse = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                name: channelName,
                type: 0, // Guild Text Channel
                parent_id: CATEGORY_ID || null,
                permission_overwrites: permissionOverwrites
            })
        });

        if (!discordResponse.ok) {
            const errText = await discordResponse.text();
            throw new Error(`Discord channel request failed: ${errText}`);
        }

        const newChannel = await discordResponse.json();

        const mentionUser = isNumericUserId ? `<@${discordId}>` : `**${discordId}**`;
        const mentionStaff = STAFF_ROLE_ID ? `<@&${STAFF_ROLE_ID}>` : 'Staff';

        // 4. Send welcoming card with candidate details directly inside the new channel
        await fetch(`https://discord.com/api/v10/channels/${newChannel.id}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `👋 Welcome ${mentionUser} and ${mentionStaff}! This private review channel has been automatically created.`,
                embeds: [
                    {
                        title: "🎵 Submitted Demo Details",
                        color: 5793266,
                        fields: [
                            { name: "🎫 Verification Ticket Code", value: `\`${ticketCode || "N/A"}\``, inline: false },
                            { name: "👤 Artist/Project", value: artistName, inline: true },
                            { name: "📧 Email", value: email, inline: true },
                            { name: "🆔 Discord User ID", value: `${discordId} (Tagged: ${mentionUser})`, inline: true },
                            { name: "🎹 Genre", value: genre || "Unknown", inline: true },
                            { name: "🔗 Audio Track Link", value: `[Listen to Track](${demoLink})`, inline: false },
                            { name: "🟢 Spotify URL", value: spotifyUrl ? `[View Spotify](${spotifyUrl})` : "Not provided.", inline: false },
                            { name: "💬 Biography / Cover Note", value: message || "No biography provided.", inline: false }
                        ],
                        timestamp: new Date().toISOString()
                    }
                ]
            })
        });

        // 5. Fire automated OpenRouter A&R analysis in the background
        if (env.OPENROUTER_API_KEY) {
            ctx.waitUntil(generateAndPostAiReview(newChannel.id, artistName, genre, env));
        }

        // 6. Post status alert to central Staff Log Webhook (if configured)
        if (env.DISCORD_WEBHOOK_URL) {
            ctx.waitUntil(sendStatusLogToStaff(newChannel.id, artistName, genre, env));
        }

        return jsonResponse({ success: true, channelId: newChannel.id });

    } catch (e) {
        console.error(e);
        return jsonResponse({ error: e.message }, 500);
    }
}

/**
 * Background Task: Sends a notification to your staff log channel [1]
 */
async function sendStatusLogToStaff(channelId, artistName, genre, env) {
    try {
        await fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                embeds: [
                    {
                        title: "✅ New Automated Demo Room Created",
                        description: `A private review channel has been automatically created for artist **${artistName}** (${genre}).\n\n👉 **Join Channel:** <#${channelId}>`,
                        color: 1061614, // Green
                        timestamp: new Date().toISOString()
                    }
                ]
            })
        });
    } catch (e) {
        console.error("Failed to send staff status log:", e);
    }
}

/**
 * Background Task: Generates an AI A&R Brief and sends it to the private channel [1]
 */
async function generateAndPostAiReview(channelId, artistName, genre, env) {
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://adronix-records.com",
                "X-Title": "Adronix Records Bot"
            },
            body: JSON.stringify({
                model: "nvidia/nemotron-3-ultra-550b-a55b:free",
                messages: [
                    {
                        role: "system",
                        content: "You are an expert A&R manager for ADRONIX RECORDS. Provide a professional, constructive brief reviewing the genre and how to scout/guide this submission. Keep your analysis under 200 words."
                    },
                    {
                        role: "user",
                        content: `Artist Name: ${artistName}\nSubmitted Genre: ${genre}\nWrite a short scouting analysis brief.`
                    }
                ]
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`[A&R AI Error] Status: ${response.status}. Payload: ${errText}`);
            return;
        }

        const data = await response.json();
        const aiReport = data.choices[0].message.content;

        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
                'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                embeds: [{
                    title: "🤖 Automated A&R Assistant Screening",
                    description: aiReport,
                    color: 15418782, // Gold color
                    footer: { text: "Powered by OpenRouter AI" }
                }]
            })
        });
    } catch (e) {
        console.error("AI automated brief failed:", e);
    }
}

/**
 * Handles Incoming Slash Commands (/close, /ask-ai)
 */
async function handleSlashCommand(interaction, env, ctx) {
    const commandName = interaction.data.name;
    const channelId = interaction.channel_id;

    if (commandName === "close") {
        ctx.waitUntil((async () => {
            await new Promise(resolve => setTimeout(resolve, 3000));
            await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });
        })());

        return jsonResponse({
            type: 4, 
            data: { content: "⚠️ **Closing review portal:** Channel will be deleted in 3 seconds..." }
        });
    }

    if (commandName === "ask-ai") {
        const question = interaction.data.options[0].value;

        ctx.waitUntil((async () => {
            try {
                const aiResponse = await getAiExplanation(question, env);

                await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        content: `💬 **Question:** *${question}*\n\n🤖 **AI Assistant:**\n${aiResponse}`
                    })
                });
            } catch (err) {
                await fetch(`https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ content: `❌ Failed to generate AI response: ${err.message}` })
                });
            }
        })());

        return jsonResponse({ type: 5 });
    }

    return jsonResponse({ error: "Unknown Command" }, 400);
}

/**
 * Request helper to query OpenRouter
 */
async function getAiExplanation(prompt, env) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://adronix-records.com",
            "X-Title": "Adronix Records Bot"
        },
        body: JSON.stringify({
            model: "nvidia/nemotron-3-ultra-550b-a55b:free",
            messages: [{ role: "user", content: prompt }]
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`[OpenRouter API Error] Status: ${response.status}. Reason: ${errorText}`);
        throw new Error(`OpenRouter returned status ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

/**
 * Registers Slash Commands with Discord
 */
async function registerCommands(env) {
    const commands = [
        {
            name: "close",
            description: "Deletes and closes this demo review channel."
        },
        {
            name: "ask-ai",
            description: "Ask the ADRONIX AI Music Assistant a question",
            options: [
                {
                    name: "question",
                    description: "What would you like to ask the AI?",
                    type: 3, 
                    required: true
                }
            ]
        }
    ];

    try {
        const response = await fetch(`https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/commands`, {
            method: "PUT",
            headers: {
                "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(commands)
        });

        if (response.ok) {
            return textResponse("Commands Registered Successfully! You can now use /close and /ask-ai in Discord.");
        } else {
            const err = await response.text();
            return textResponse(`Failed to register: ${err}`, 400);
        }
    } catch (error) {
        return textResponse(`Error: ${error.message}`, 500);
    }
}

/**
 * Cryptographic Signature verification for Discord Webhooks
 */
async function verifySignature(request, publicKeyHex) {
    const signature = request.headers.get('X-Signature-Ed25519');
    const timestamp = request.headers.get('X-Signature-Timestamp');
    const body = await request.clone().text();

    if (!signature || !timestamp || !publicKeyHex) return false;

    try {
        const pubKey = await crypto.subtle.importKey(
            'raw',
            hexToUint8Array(publicKeyHex),
            { name: 'Ed25519', namedCurve: 'Ed25519' },
            true,
            ['verify']
        );

        const data = new TextEncoder().encode(timestamp + body);
        const sig = hexToUint8Array(signature);

        return await crypto.subtle.verify('Ed25519', pubKey, sig, data);
    } catch (e) {
        return false;
    }
}

function hexToUint8Array(hex) {
    if (!hex) return new Uint8Array(0);
    const pairs = hex.match(/.{1,2}/g);
    if (!pairs) return new Uint8Array(0);
    return new Uint8Array(pairs.map(val => parseInt(val, 16)));
}