const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const https = require("https");
const { randomUUID } = require("crypto");
require("dotenv").config();

const port = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || "http://localhost:1234";
const apiUrl = `${BASE_URL}/api/chat/openai`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function authMiddleware(req, res, next) {
  const authToken = process.env.AUTH_TOKEN;

  if (authToken) {
    const reqAuthToken = req.headers.authorization;
    if (reqAuthToken && reqAuthToken === `Bearer ${authToken}`) {
      next();
    } else {
      res.sendStatus(401);
    }
  } else {
    next();
  }
}

function GenerateCompletionId(prefix = "cmpl-") {
  const characters =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = 28;

  for (let i = 0; i < length; i++) {
    prefix += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return prefix;
}

async function* chunksToLines(chunksAsync) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
    let eolIndex;
    while ((eolIndex = previous.indexOf("\n")) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === "data: [DONE]") break;
      if (line.startsWith("data: ")) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

async function* linesToMessages(linesAsync) {
  for await (const line of linesAsync) {
    const message = line.substring("data :".length);

    yield message;
  }
}

async function* StreamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

// Function to create JWT
function createJWT() {
  const now = Math.floor(Date.now() / 1000);
  const accessCode = process.env.ACCESS_CODE || "";
  const payload = {
    accessCode: accessCode,
    apiKey: "",
    endpoint: "",
    iat: now,
    exp: now + 100,
  };

  return `http_nosafe.${Buffer.from(JSON.stringify(payload)).toString("base64")}`;
}

const axiosInstance = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "oai-language": "en-US",
    origin: BASE_URL,
    pragma: "no-cache",
    referer: BASE_URL,
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  },
});

// Middleware to enable CORS and handle pre-flight requests
function enableCORS(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
}

async function handleChatCompletion(req, res) {
  console.log(
    "Request:",
    `${req.method} ${req.originalUrl}`,
    `${req.body?.messages?.length || 0} messages`,
    req.body.stream ? "(stream-enabled)" : "(stream-disabled)",
  );

  try {
    const body = {
      model: req.body.model || "gpt-3.5-turbo",
      stream: true,
      frequency_penalty: 0,
      presence_penalty: 0,
      temperature: 0.6,
      top_p: 1,
      messages: req.body.messages.map((message) => ({
        content: message.content,
        role: message.role === 'system' ? 'user' : message.role,
      })),
    };

    const JWT = createJWT();

    if (!req.body.stream) {
  const response = await axiosInstance.post(apiUrl, body, {
    responseType: "stream",
    headers: {
      "x-lobe-chat-auth": JWT,
      "Content-Type": "application/json",
    },
  });

  let fullContent = "";
  let requestId = GenerateCompletionId("chatcmpl-");
  let created = Date.now();

  for await (const chunk of response.data) {
    fullContent += chunk.toString();
  }

    const returnMessage = {
    id: requestId, 
    created: created, 
    model: req.body.model || "gpt-3.5-turbo",
    object: "chat.completion",
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: {
          content: fullContent, 
          role: "assistant", 
        },
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
  console.log(returnMessage.choices);
  res.json(returnMessage);
} else {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const response = await axiosInstance.post(apiUrl, body, {
        responseType: "stream",
        headers: {
          "x-lobe-chat-auth": JWT,
          "Content-Type": "application/json",
        },
      });

      let fullContent = "";
      let requestId = GenerateCompletionId("chatcmpl-");
      let created = Date.now();

      // Stream processing
      for await (const chunk of response.data) {
        const chunkStr = chunk.toString();
        // console.log("Chunk received:", chunkStr);
        fullContent += chunkStr; // Accumulate the content

        const responsePayload = {
          id: requestId,
          created: created,
          object: "chat.completion.chunk",
          model: req.body.model || "gpt-3.5-turbo",
          choices: [
            {
              delta: {
                content: chunkStr,
              },
              index: 0,
              finish_reason: null,
            },
          ],
        };
        console.log(responsePayload.choices);
        res.write(`data: ${JSON.stringify(responsePayload)}\n\n`);
      }

      //      res.write(`event: end\ndata: {}\n\n`);
      res.end();
    }
  } catch (error) {
    console.error("Error handling chat completion:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    res.end(
      JSON.stringify({
        status: false,
        error: {
          message: "An error occurred while processing your request.",
          type: "server_error",
        },
      }),
    );
  }
}

const app = express();
app.use(bodyParser.json());
app.use(enableCORS);

// Route to handle POST requests for chat completions
app.post("/v1/chat/completions", authMiddleware, handleChatCompletion);

// 404 handler for unmatched routes
app.use((req, res) =>
  res.status(404).send({
    status: false,
    error: {
      message: `The requested endpoint was not found.`,
      type: "invalid_request_error",
    },
  }),
);

app.listen(port, () => {
  console.log(`💡 Server is running at http://localhost:${port}`);
  console.log();
  console.log(`🔗 Base URL: http://localhost:${port}/v1`);
  console.log(
    `🔗 ChatCompletion Endpoint: http://localhost:${port}/v1/chat/completions`,
  );
});

