import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  writeJSON,
  type RecordingInterval,
  type RecordingLocation,
} from "./manifests.js";

const presenceSessionSchema = z
  .object({
    joinedAt: z.iso.datetime(),
    leftAt: z.iso.datetime().nullable(),
  })
  .strict();

const participantSchema = z
  .object({
    userID: z.string().min(1),
    username: z.string().nullable(),
    displayName: z.string().nullable(),
    sessions: z.array(presenceSessionSchema),
    speakingDurationMs: z.number().int().min(0),
  })
  .strict();

const participantDocumentSchema = z
  .object({
    version: z.literal(1),
    recordingID: z.string().min(1),
    updatedAt: z.iso.datetime(),
    participants: z.array(participantSchema),
  })
  .strict();

export type ParticipantDocument = z.infer<typeof participantDocumentSchema>;

export interface ParticipantSnapshot {
  userID: string;
  username: string | null;
  displayName: string | null;
}

const documentPath = (location: RecordingLocation): string =>
  path.join(location.directory, "participants.json");

export const readParticipants = async (
  location: RecordingLocation,
): Promise<ParticipantDocument | null> => {
  try {
    return participantDocumentSchema.parse(
      JSON.parse(await readFile(documentPath(location), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const saveParticipants = async (
  location: RecordingLocation,
  document: ParticipantDocument,
): Promise<void> => {
  document.updatedAt = new Date().toISOString();
  document.participants.sort((left, right) =>
    left.userID.localeCompare(right.userID),
  );
  await writeJSON(documentPath(location), document);
};

export const initializeParticipants = async (
  location: RecordingLocation,
  recordingID: string,
  participants: ParticipantSnapshot[],
  joinedAt: string,
): Promise<void> => {
  const unique = new Map(
    participants.map((participant) => [participant.userID, participant]),
  );
  await saveParticipants(location, {
    version: 1,
    recordingID,
    updatedAt: joinedAt,
    participants: [...unique.values()].map((participant) => ({
      ...participant,
      sessions: [{ joinedAt, leftAt: null }],
      speakingDurationMs: 0,
    })),
  });
};

export const updateParticipantPresence = async (
  location: RecordingLocation,
  recordingID: string,
  participant: ParticipantSnapshot,
  present: boolean,
  occurredAt = new Date().toISOString(),
): Promise<void> => {
  const document = (await readParticipants(location)) ?? {
    version: 1 as const,
    recordingID,
    updatedAt: occurredAt,
    participants: [],
  };
  let current = document.participants.find(
    (candidate) => candidate.userID === participant.userID,
  );
  if (!current) {
    current = {
      ...participant,
      sessions: [],
      speakingDurationMs: 0,
    };
    document.participants.push(current);
  } else {
    current.username = participant.username;
    current.displayName = participant.displayName;
  }
  const openSession = [...current.sessions]
    .reverse()
    .find((session) => session.leftAt === null);
  if (present && !openSession) {
    current.sessions.push({ joinedAt: occurredAt, leftAt: null });
  }
  if (!present && openSession) openSession.leftAt = occurredAt;
  await saveParticipants(location, document);
};

export const finalizeParticipants = async (
  location: RecordingLocation,
  recordingID: string,
  intervals: RecordingInterval[],
  endedAt: string,
): Promise<void> => {
  const document = (await readParticipants(location)) ?? {
    version: 1 as const,
    recordingID,
    updatedAt: endedAt,
    participants: [],
  };
  const durations = new Map<string, number>();
  for (const interval of intervals) {
    if (interval.kind !== "speaking" || !interval.userID) continue;
    durations.set(
      interval.userID,
      (durations.get(interval.userID) ?? 0) +
        Math.max(0, interval.endOffsetMs - interval.startOffsetMs),
    );
    if (
      !document.participants.some(
        (participant) => participant.userID === interval.userID,
      )
    ) {
      document.participants.push({
        userID: interval.userID,
        username: interval.username,
        displayName: interval.displayName,
        sessions: [],
        speakingDurationMs: 0,
      });
    }
  }
  for (const participant of document.participants) {
    for (const session of participant.sessions) {
      if (session.leftAt === null) session.leftAt = endedAt;
    }
    participant.speakingDurationMs = durations.get(participant.userID) ?? 0;
  }
  await saveParticipants(location, document);
};
