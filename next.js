import { flatMap, chunk, join } from "lodash-es";
import OpenAI from "openai";
import moment from "moment-timezone";
import { encode } from "gpt-3-encoder";
import fs from "fs";
import { extname } from "path";
import { exec } from "child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import natural from "natural";
import { jsonrepair } from "jsonrepair";
import { franc, francAll } from "franc";
import { promisify } from "util";
import retry from "async-retry";

const execAsync = promisify(exec);
const LANGUAGES = [
  {
    label: "Afrikaans",
    value: "af",
  },
  {
    label: "Arabic",
    value: "ar",
  },
  {
    label: "Armenian",
    value: "hy",
  },
  {
    label: "Azerbaijani",
    value: "az",
  },
  {
    label: "Belarusian",
    value: "be",
  },
  {
    label: "Bosnian",
    value: "bs",
  },
  {
    label: "Bulgarian",
    value: "bg",
  },
  {
    label: "Catalan",
    value: "ca",
  },
  {
    label: "Chinese",
    value: "zh",
  },
  {
    label: "Croatian",
    value: "hr",
  },
  {
    label: "Czech",
    value: "cs",
  },
  {
    label: "Danish",
    value: "da",
  },
  {
    label: "Dutch",
    value: "nl",
  },
  {
    label: "English",
    value: "en",
  },
  {
    label: "Estonian",
    value: "et",
  },
  {
    label: "Finnish",
    value: "fi",
  },
  {
    label: "French",
    value: "fr",
  },
  {
    label: "Galician",
    value: "gl",
  },
  {
    label: "German",
    value: "de",
  },
  {
    label: "Greek",
    value: "el",
  },
  {
    label: "Hebrew",
    value: "he",
  },
  {
    label: "Hindi",
    value: "hi",
  },
  {
    label: "Hungarian",
    value: "hu",
  },
  {
    label: "Icelandic",
    value: "is",
  },
  {
    label: "Indonesian",
    value: "id",
  },
  {
    label: "Italian",
    value: "it",
  },
  {
    label: "Japanese",
    value: "ja",
  },
  {
    label: "Kannada",
    value: "kn",
  },
  {
    label: "Kazakh",
    value: "kk",
  },
  {
    label: "Korean",
    value: "ko",
  },
  {
    label: "Latvian",
    value: "lv",
  },
  {
    label: "Lithuanian",
    value: "lt",
  },
  {
    label: "Macedonian",
    value: "mk",
  },
  {
    label: "Malay",
    value: "ms",
  },
  {
    label: "Marathi",
    value: "mr",
  },
  {
    label: "Maori",
    value: "mi",
  },
  {
    label: "Nepali",
    value: "ne",
  },
  {
    label: "Norwegian",
    value: "no",
  },
  {
    label: "Persian",
    value: "fa",
  },
  {
    label: "Polish",
    value: "pl",
  },
  {
    label: "Portuguese",
    value: "pt",
  },
  {
    label: "Romanian",
    value: "ro",
  },
  {
    label: "Russian",
    value: "ru",
  },
  {
    label: "Serbian",
    value: "sr",
  },
  {
    label: "Slovak",
    value: "sk",
  },
  {
    label: "Slovenian",
    value: "sl",
  },
  {
    label: "Spanish",
    value: "es",
  },
  {
    label: "Swahili",
    value: "sw",
  },
  {
    label: "Swedish",
    value: "sv",
  },
  {
    label: "Tagalog",
    value: "tl",
  },
  {
    label: "Tamil",
    value: "ta",
  },
  {
    label: "Thai",
    value: "th",
  },
  {
    label: "Turkish",
    value: "tr",
  },
  {
    label: "Ukrainian",
    value: "uk",
  },
  {
    label: "Urdu",
    value: "ur",
  },
  {
    label: "Vietnamese",
    value: "vi",
  },
  {
    label: "Welsh",
    value: "cy",
  },
];

function repairJSON(input) {
  let jsonObj;
  try {
    jsonObj = JSON.parse(input);
    console.log(`JSON repair not needed.`);
    return jsonObj;
  } catch (error) {
    try {
      console.log(`Encountered an error: ${error}. Attempting JSON repair...`);
      const cleanedJsonString = jsonrepair(input);
      jsonObj = JSON.parse(cleanedJsonString);
      console.log(`JSON repair successful.`);
      return jsonObj;
    } catch (error) {
      console.log(
        `First JSON repair attempt failed with error: ${error}. Attempting more involved JSON repair...`
      );
      try {
        const beginningIndex = Math.min(
          input.indexOf("{") !== -1 ? input.indexOf("{") : Infinity,
          input.indexOf("[") !== -1 ? input.indexOf("[") : Infinity
        );
        const endingIndex = Math.max(
          input.lastIndexOf("}") !== -1 ? input.lastIndexOf("}") : -Infinity,
          input.lastIndexOf("]") !== -1 ? input.lastIndexOf("]") : -Infinity
        );

        if (beginningIndex == Infinity || endingIndex == -1) {
          throw new Error("No JSON object or array found (in repairJSON).");
        }

        const cleanedJsonString = jsonrepair(
          input.substring(beginningIndex, endingIndex + 1)
        );
        jsonObj = JSON.parse(cleanedJsonString);
        console.log(`2nd-stage JSON repair successful.`);
        return jsonObj;
      } catch (error) {
        throw new Error(
          `Recieved invalid JSON from ChatGPT. All JSON repair efforts failed.`
        );
      }
    }
  }
}

async function chunkFileAndTranscribe({ file }, openai) {
  const chunkDirName = "chunks";
  const outputDir = join("/tmp", chunkDirName);
  await execAsync(`mkdir -p "${outputDir}"`);
  await execAsync(`rm -f "${outputDir}/*"`);

  try {
    console.log(`Chunking file: ${file}`);
    await chunkFile({
      file,
      outputDir,
    });

    const files = await fs.promises.readdir(outputDir);

    console.log(`Chunks created successfully. Transcribing chunks: ${files}`);
    return await transcribeFiles(
      {
        files,
        outputDir,
      },
      openai
    );
  } catch (error) {
    let errorText;

    if (/connection error/i.test(error.message)) {
      errorText = `An error occured while attempting to split the file into chunks, or while sending the chunks to OpenAI.
					
					If the full error below says "Unidentified connection error", please double-check that you have entered valid billing info in your OpenAI account. Afterward, generate a new API key and enter it in the OpenAI app here in Pipedream. Then, try running the workflow again.
					
					If that does not work, please open an issue at this workflow's Github repo: https://github.com/TomFrankly/pipedream-notion-voice-notes/issues`;
    } else if (/Invalid file format/i.test(error.message)) {
      errorText = `An error occured while attempting to split the file into chunks, or while sending the chunks to OpenAI.
					Note: OpenAI officially supports .m4a files, but some apps create .m4a files that OpenAI can't read. If you're using an .m4a file, try converting it to .mp3 and running the workflow again.`;
    } else {
      errorText = `An error occured while attempting to split the file into chunks, or while sending the chunks to OpenAI.`;
    }

    throw new Error(
      `${errorText}
					Full error from OpenAI: ${error.message}`
    );
  }
}
async function chunkFile({ file, outputDir }) {
  const ffmpegPath = ffmpegInstaller.path;
  const ext = extname(file);

  const fileSizeInMB = fs.statSync(file).size / (1024 * 1024);
  const chunkSize = this.chunk_size ?? 24;
  const numberOfChunks = Math.ceil(fileSizeInMB / chunkSize);

  console.log(
    `Full file size: ${fileSizeInMB}mb. Chunk size: ${chunkSize}mb. Expected number of chunks: ${numberOfChunks}. Commencing chunking...`
  );

  if (numberOfChunks === 1) {
    await execAsync(`cp "${file}" "${outputDir}/chunk-000${ext}"`);
    console.log(`Created 1 chunk: ${outputDir}/chunk-000${ext}`);
    return;
  }

  const { stdout: durationOutput } = await execAsync(
    `${ffmpegPath} -i "${file}" 2>&1 | grep "Duration"`
  );
  const duration = durationOutput.match(/\d{2}:\d{2}:\d{2}\.\d{2}/s)[0];
  const [hours, minutes, seconds] = duration.split(":").map(parseFloat);

  const totalSeconds = hours * 60 * 60 + minutes * 60 + seconds;
  const segmentTime = Math.ceil(totalSeconds / numberOfChunks);

  const command = `${ffmpegPath} -i "${file}" -f segment -segment_time ${segmentTime} -c copy -loglevel verbose "${outputDir}/chunk-%03d${ext}"`;
  console.log(`Spliting file into chunks with ffmpeg command: ${command}`);

  try {
    const { stdout: chunkOutput, stderr: chunkError } = await execAsync(
      command
    );

    if (chunkOutput) {
      console.log(`stdout: ${chunkOutput}`);
    }

    if (chunkError) {
      console.log(`stderr: ${chunkError}`);
    }

    const chunkFiles = await fs.promises.readdir(outputDir);
    const chunkCount = chunkFiles.filter((file) =>
      file.includes("chunk-")
    ).length;
    console.log(`Created ${chunkCount} chunks.`);
  } catch (error) {
    console.error(
      `An error occurred while splitting the file into chunks: ${error}`
    );
    throw error;
  }
}
function transcribeFiles({ files, outputDir }, openai) {
  return Promise.all(
    files.map((file) => {
      return transcribe(
        {
          file,
          outputDir,
        },
        openai
      );
    })
  );
}
function transcribe({ file, outputDir }, openai) {
  return retry(
    async (bail) => {
      const readStream = fs.createReadStream(join(outputDir, file));
      console.log(`Transcribing file: ${file}`);

      try {
        const response = await openai.audio.transcriptions
          .create(
            {
              model: "whisper-1",
              file: readStream,
              prompt:
                this.whisper_prompt && this.whisper_prompt !== ""
                  ? this.whisper_prompt
                  : `Hello, welcome to my lecture.`,
            },
            {
              maxRetries: 5,
            }
          )
          .withResponse();

        const limits = {
          requestRate: response.response.headers.get(
            "x-ratelimit-limit-requests"
          ),
          tokenRate: response.response.headers.get("x-ratelimit-limit-tokens"),
          remainingRequests: response.response.headers.get(
            "x-ratelimit-remaining-requests"
          ),
          remainingTokens: response.response.headers.get(
            "x-ratelimit-remaining-tokens"
          ),
          rateResetTimeRemaining: response.response.headers.get(
            "x-ratelimit-reset-requests"
          ),
          tokenRestTimeRemaining: response.response.headers.get(
            "x-ratelimit-reset-tokens"
          ),
        };
        console.log(
          `Received response from OpenAI Whisper endpoint for ${file}. Your API key's current Audio endpoing limits (learn more at https://platform.openai.com/docs/guides/rate-limits/overview):`
        );
        console.table(limits);

        if (limits.remainingRequests <= 1) {
          console.log(
            "WARNING: Only 1 request remaining in the current time period. Rate-limiting may occur after the next request. If so, this script will attempt to retry with exponential backoff, but the workflow run may hit your Timeout Settings (https://pipedream.com/docs/workflows/settings/#execution-timeout-limit) before completing. If you have not upgraded your OpenAI account to a paid account by adding your billing information (and generated a new API key afterwards, replacing your trial key here in Pipedream with that new one), your trial API key is subject to low rate limits. Learn more here: https://platform.openai.com/docs/guides/rate-limits/overview"
          );
        }

        return response;
      } catch (error) {
        if (error instanceof OpenAI.APIError) {
          console.log(`Encounted error from OpenAI: ${error.message}`);
          console.log(`Status code: ${error.status}`);
          console.log(`Error name: ${error.name}`);
          console.log(`Error headers: ${JSON.stringify(error.headers)}`);
        } else {
          console.log(
            `Encountered generic error, not described by OpenAI SDK error handler: ${error}`
          );
        }

        if (
          error.message.toLowerCase().includes("econnreset") ||
          error.message.toLowerCase().includes("connection error") ||
          (error.status && error.status >= 500)
        ) {
          console.log(`Encountered a recoverable error. Retrying...`);
          throw error;
        } else {
          console.log(
            `Encountered an error that won't be helped by retrying. Bailing...`
          );
          bail(error);
        }
      } finally {
        readStream.destroy();
      }
    },
    {
      retries: 3,
      onRetry: (err) => {
        console.log(`Retrying transcription for ${file} due to error: ${err}`);
      },
    }
  );
}
async function combineWhisperChunks(chunksArray) {
  console.log(
    `Combining ${chunksArray.length} transcript chunks into a single transcript...`
  );

  try {
    let combinedText = "";

    for (let i = 0; i < chunksArray.length; i++) {
      let currentChunk = chunksArray[i].data.text;
      let nextChunk =
        i < chunksArray.length - 1 ? chunksArray[i + 1].data.text : null;

      if (
        nextChunk &&
        currentChunk.endsWith(".") &&
        nextChunk.charAt(0).toLowerCase() === nextChunk.charAt(0)
      ) {
        currentChunk = currentChunk.slice(0, -1);
      }

      if (i < chunksArray.length - 1) {
        currentChunk += " ";
      }

      combinedText += currentChunk;
    }

    console.log("Transcript combined successfully.");
    return combinedText;
  } catch (error) {
    throw new Error(
      `An error occurred while combining the transcript chunks: ${error.message}`
    );
  }
}

class GptSentenceUtils {
  static divideTextEvenly(text, maxTokenCountPerChunk) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const totalTokens = encode(text).length;
    const minChunks = Math.ceil(totalTokens / maxTokenCountPerChunk); //?

    // Initial division of sentences into chunks
    let chunks = chunk(sentences, Math.ceil(sentences.length / minChunks));
    console.log(`Initial chunk count: ${chunks.length}`);

    return flatMap(chunks, (chunk, index, array) => {
      let modifiedChunk = chunk;
      while (encode(join(modifiedChunk, "")).length > maxTokenCountPerChunk) {
        // Ensuring the last chunk does not exceed maxTokenCountPerChunk
        if (index === array.length - 1) {
          return chunk(modifiedChunk, modifiedChunk.length - 1).map(
            (innerChunk) => join(innerChunk, " ")
          );
        } else {
          // Move the last sentence to the next chunk
          const lastSentence = modifiedChunk.pop();
          array[index + 1].unshift(lastSentence);
        }
      }
      return [join(modifiedChunk, "")];
    });
  }
}

function isObject(item) {
  return item && typeof item === "object" && !Array.isArray(item);
}

function mergeDeep(objectsArray) {
  const merged = {};

  for (const obj of objectsArray) {
    for (const key in obj) {
      if (!obj.hasOwnProperty(key)) continue;

      if (isObject(obj[key])) {
        // Merge objects recursively
        merged[key] = isObject(merged[key])
          ? mergeDeep([merged[key], obj[key]])
          : obj[key];
      } else if (Array.isArray(obj[key])) {
        // Concatenate arrays
        merged[key] = (merged[key] || []).concat(obj[key]);
      } else if (typeof obj[key] === "string" && key !== "title") {
        // Concatenate strings
        merged[key] = (merged[key] || "") + obj[key];
      } else {
        // For other types, use the value from the current object
        merged[key] = obj[key];
      }
    }
  }

  return merged;
}

function titleCase(str) {
  return str
    .replace(/_/g, " ") // Replace all underscores with spaces
    .replace(/\b\w/g, (char) => char.toUpperCase()); // Capitalize the first character of each word
}

const CHECKBOXES = {
  follow_up: 1,
  reminders: 1,
  action_items: 1,
  actionable_ideas: 1,
};
function formatValue(key, val) {
  // if val is an array, return it as a markdown list or checkbox seperated by newlines (check if the key should be a checkbox)
  if (Array.isArray(val)) {
    if (CHECKBOXES[key]) {
      return val.map((item) => `- [ ] ${item}`).join("\n");
    }
    return val.map((item) => `- ${item}`).join("\n");
  }
  return val;
}

const SYSTEM_MESSAGES = {
  default: `You are a flexible assistant capable of processing and summarizing different types of textual input, such as notes, conversations, lectures, or journal entries. Based on the user-provided date and text type (e.g., 'note', 'conversation', 'lecture', 'journal'), your output must be in valid JSON format, written in English. Analyze the content to extract key themes, action items, and follow-up points, tailored to the input type.

Generate the following keys, adapting to the specific type of input:
- "title": Create a relevant title based on the input's main theme, including the date.
- "key_summary": Provide a concise summary or key points, customized to the text type.
- "action_items": List any tasks or follow-up actions pertinent to the text.
- "additional_queries": Suggest questions or areas for further exploration related to the input.
- "categorized_insights": (Conditional) If the input is a 'lecture' or 'conversation', categorize insights or main points.
- "personal_reflections": (Conditional) If the input is a 'journal' or 'note', offer prompts for personal reflection or application.
- "urgent_highlights": Highlight any urgent or significant details, if mentioned.
- "resource_links": (Optional) Include links to resources for further reading or information, where applicable.

Ensure no trailing commas in JSON arrays. All responses should strictly adhere to JSON syntax, be in English, and avoid non-JSON text. Keep the response succinct and directly relevant to the input type.`,
  notes: `You are a digital assistant optimized for processing and structuring various types of notes. Users provide the date and the content of their notes. Your output must be in valid JSON format, written in English. Analyze the content to categorize notes, highlight key information, identify action items, and suggest areas for further exploration or clarification.

Format the following keys from the notes provided:
- "title": Create a title that reflects the overall theme or subject of the notes, including the date.
- "categorized_content": Organize the notes into categories like 'Ideas', 'Tasks', 'Questions', 'Observations', etc.
- "key_points": Extract and list the most important points or takeaways.
- "action_items": Identify tasks or actions implied or explicitly mentioned in the notes.
- "clarifying_questions": Propose questions that would help clarify uncertainties or expand on ideas in the notes.
- "follow_up_resources": Suggest resources (books, articles, websites) for further information related to the notes' content.
- "personal_remarks": Add a section for personal comments, interpretations, or reflections on the notes.
- "urgent_matters": Highlight any urgent or time-sensitive issues mentioned.
- "future_ideas": Note down any future projects, plans, or ideas hinted at or suggested.
- "miscellaneous": Include a section for any miscellaneous or uncategorized information from the notes.

Ensure there are no trailing commas in JSON arrays. All responses should strictly follow JSON syntax rules, be in English, and exclude any non-JSON text. Do not enclose the response in code block wrappers.`,
  lecture: `You are an intelligent assistant specialized in processing and summarizing lecture content. Users provide the date and a transcript of the lecture. Your outputs must be structured as valid JSON, written in English. Analyze the lecture to extract core concepts, important details, questions raised, and areas for further study. Offer a concise summary and suggest resources for deeper understanding.

Generate the following keys from the lecture transcript:
- "title": Develop a title that encapsulates the main theme of the lecture, including the date.
- "core_concepts": Enumerate the central ideas or theories presented in the lecture.
- "key_details": Highlight significant facts, figures, or examples mentioned.
- "questions_raised": List any questions or uncertainties that emerged during the lecture.
- "summary": Provide a brief, comprehensive summary of the lecture's content.
- "further_reading": Suggest books, articles, or other resources for extended learning on the topics covered.
- "lecture_insights": Identify insightful or particularly enlightening segments of the lecture.
- "actionable_ideas": Note ideas or concepts from the lecture that can be applied or explored further.
- "reflections": Offer prompts for personal reflection or application of the lecture material.
- "future_topics": Mention any upcoming topics or subjects hinted at for future lectures.

Ensure there are no trailing commas in JSON arrays. All responses should adhere to JSON syntax, be exclusively in English, and avoid non-JSON text. Do not wrap the response in code block wrappers.`,
  day_planner: `You are a smart assistant designed to organize and optimize daily plans. The user will provide the current date and a voice note transcript. Your responses must be in valid JSON format, written in English. When summarizing the day's plan, estimate the time, energy, and focus required for each activity. Suggest optimal times for activities, break down complex tasks into manageable steps, and brainstorm additional ideas.

Analyze the transcript provided, then provide the following keys:
- "title": Craft a title using keywords from the transcript, include '📅', and the date.
- "day_plan": Create a markdown list of tasks as checkboxes. Include estimated completion time, time range, priority level, and any potential obstacles.
- "appointments": List scheduled meetings as checkboxes, detailing the time, date, and location.
- "goals": Outline personal or professional objectives for the day as checkboxes.
- "deadlines": Note final deadlines for tasks or projects as checkboxes, specifying times or dates.
- "task_breakdown": Offer a breakdown of complex tasks into smaller, actionable steps.
- "energy_and_focus": Assess and note the energy and focus level required for each task.
- "considerations": Provide an array of potential considerations or challenges regarding the day plan.
- "follow_up": Suggest follow-up ideas or questions to enhance task completion or planning.
- "reminders": List any mentioned reminders or important notes.

Ensure no trailing commas in any JSON arrays. All responses should strictly adhere to JSON syntax, avoiding any non-JSON text. JSON keys must be in English, and the entire response should be in plain JSON format without code block wrappers.`,
  journal: `You are a digital journal assistant designed to facilitate reflective journaling. Users provide a date and a transcript of their thoughts or experiences. Your responses must be formatted as valid JSON, composed in English. Analyze the transcript to identify themes, emotions, and key experiences. Offer suggestions for personal growth, provide prompts for deeper reflection, and identify areas of gratitude or learning.

Generate the following keys from the journal transcript:
- "title": Create a title reflecting the main themes or emotions of the journal entry, including the date.
- "daily_reflections": List significant thoughts or experiences as markdown bullet points.
- "emotional_insights": Identify and categorize emotions expressed in the entry.
- "learning_points": Highlight lessons learned or insights gained during the day.
- "gratitude_notes": Enumerate moments or aspects the user is grateful for.
- "personal_growth": Suggest areas for personal development or improvement.
- "reflective_questions": Provide thought-provoking questions based on the entry for deeper introspection.
- "mood_tracker": Assess the overall mood of the entry and categorize it.
- "memorable_moments": Identify and list standout moments or experiences.
- "future_goals": Note any future aspirations or goals mentioned in the entry.

Ensure no trailing commas in JSON arrays. All responses should adhere to JSON syntax rules, strictly in English. Avoid non-JSON text and do not enclose the response in code block wrappers.`,
  interview: `You are an intelligent assistant tailored for analyzing and summarizing interviews or conversations. Users provide the date and a transcript of the dialogue. Your output must be in valid JSON format, written in English. From the conversation, identify main topics, notable quotes, areas of agreement or disagreement, and potential action items. Offer suggestions for further discussion or research based on the dialogue.

Construct the following keys from the interview transcript:
- "title": Formulate a title that captures the essence of the conversation, including the date.
- "key_topics": List the main topics discussed as markdown bullet points.
- "notable_quotes": Highlight significant statements or quotes from the conversation.
- "agreements_disagreements": Identify areas where participants agreed or disagreed.
- "action_items": Suggest actionable steps or follow-ups based on the discussion.
- "insightful_moments": Point out insightful or revealing moments in the dialogue.
- "participant_perspectives": Summarize each participant's viewpoint or stance on key topics.
- "questions_for_clarification": Provide questions that could clarify ambiguities or deepen understanding.
- "future_discussion_points": Note topics or questions for potential future conversations.
- "additional_research": Suggest areas for further research or exploration relevant to the discussion.

Ensure no trailing commas in JSON arrays. Responses should strictly follow JSON syntax, be in English, and avoid non-JSON text. Do not enclose the response in code block wrappers.`,
};

let type;

async function processSinglePrompt(openai, prompt) {
  let messages = [
    { role: "system", content: SYSTEM_MESSAGES[type] },
    {
      role: "user",
      content: `Now: ${date}
Prompt:${prompt}`,
    },
  ];
  let completion;
  let ans = [];
  let count = 0;
  do {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: messages,
      // response_format: "json_object",
    });
    completion = response.choices[0];
    console.log(response);
    count++;
    if (count > 2) {
      console.log(`Completion ${count}: `);
    }
    ans.push(completion.message.content);
    messages.push(completion.message); // Append the latest response to the messages
  } while (completion.finish_reason !== "stop");
  const ret = ans.join("");
  return ret;
}

async function processMultiplePrompts(openai, prompts) {
  const processingTasks = prompts.map((prompt) =>
    processSinglePrompt(openai, prompt)
  );
  const results = (await Promise.all(processingTasks)).map((x) =>
    repairJSON(x)
  );
  const combined = mergeDeep(results);
  console.log(combined);
  return combined;
}

let date;
export default defineComponent({
  name: "GPT to Notion",
  key: "note-summary-to-notion",
  version: "0.0.1",
  type: "action",
  props: {
    openai: {
      type: "app",
      app: "openai",
    },
    file_path: {
      type: "string",
      label:
        "File Path (name will be also used to determine type: notes|lecture|day planner|journal|interview)",
    },
    timezone: {
      type: "string",
      label: "Timezone (to put a date to the file)",
    },
  },
  async run({ $ }) {
    type =
      this.file_path
        .match(/(notes|lecture|day planner|journal|interview)/i)?.[0]
        ?.toLowerCase() || "default";
    date = moment
      .tz(new Date(), "America/Chicago")
      .format("YYYY-MM-DD_HH-mm-ss");
    console.log(`Type: ${type}`);

    function processJson(summary, transcript) {
      $.export("name", summary.title);
      const { title, ...bodyRest } = summary;
      bodyRest.transcript = transcript;
      const body = Object.keys(bodyRest)
        .map((key) => {
          return `## ${titleCase(key)}\n${formatValue(key, bodyRest[key])}\n\n`;
        })
        .join("");
      $.export("body", body);
    }
    const openai = new OpenAI({ apiKey: this.openai.$auth.api_key });
    const whisper = await chunkFileAndTranscribe(
      { file: this.file_path },
      openai
    );
    const full_transcript = combineWhisperChunks(whisper);

    // token count for the completion can get up to 1000 tokens, so we need to split the transcript into chunks of 3000 tokens to stay under the 4k limit for gpt-3.5-turbo
    const summary = await processMultiplePrompts(
      openai,
      GptSentenceUtils.divideTextEvenly(full_transcript, 3000)
    );
    processJson(summary, full_transcript);
  },
});
