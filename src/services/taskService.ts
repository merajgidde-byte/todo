import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import {
  CATEGORIES,
  PRIORITIES,
  type Category,
  type Priority,
  type Task,
} from '../types/task';

const TASKS_COLLECTION = 'tasks';
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function createValidTaskId(): string {
  const raw =
    typeof window !== 'undefined' && window.crypto?.randomUUID
      ? window.crypto.randomUUID()
      : `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return ID_PATTERN.test(sanitized) ? sanitized : `t_${Date.now().toString(36)}`;
}

function sanitizeTitle(input: string): string {
  return input.trim().slice(0, 180);
}

function sanitizeDueDate(input: string): string {
  const trimmed = input.trim();
  return DUE_DATE_PATTERN.test(trimmed) ? trimmed : '';
}

function sanitizePriority(input: string): Priority {
  return PRIORITIES.includes(input as Priority)
    ? (input as Priority)
    : 'Medium';
}

function sanitizeCategory(input: string): Category {
  return CATEGORIES.includes(input as Category)
    ? (input as Category)
    : 'General';
}

function toMillis(value: unknown): number {
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof (value as { toMillis: unknown }).toMillis === 'function'
  ) {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (typeof value === 'number') {
    return value;
  }
  return Date.now();
}

export function subscribeToTasks(
  userId: string,
  onTasks: (tasks: Task[]) => void,
  onError: (error: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, TASKS_COLLECTION),
    where('userId', '==', userId)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const nextTasks: Task[] = snapshot.docs.map((docSnap) => {
        const data = docSnap.data();
        return {
          id: docSnap.id,
          title: typeof data.title === 'string' ? data.title : '',
          priority: sanitizePriority(String(data.priority ?? 'Medium')),
          dueDate:
            typeof data.dueDate === 'string' ? sanitizeDueDate(data.dueDate) : '',
          category: sanitizeCategory(String(data.category ?? 'General')),
          completed: Boolean(data.completed),
          createdAt: toMillis(data.createdAt),
        };
      });
      onTasks(nextTasks);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, TASKS_COLLECTION);
      } catch (wrappedError) {
        onError(
          wrappedError instanceof Error
            ? wrappedError
            : new Error(String(wrappedError))
        );
      }
    }
  );
}

export interface CreateTaskPayload {
  userId: string;
  title: string;
  priority: Priority;
  dueDate: string;
  category: Category;
}

export async function createTaskInFirestore(
  payload: CreateTaskPayload
): Promise<string> {
  const taskId = createValidTaskId();
  const title = sanitizeTitle(payload.title);
  if (!title) {
    throw new Error('Task title cannot be empty.');
  }

  const docPath = `${TASKS_COLLECTION}/${taskId}`;
  try {
    await setDoc(doc(db, TASKS_COLLECTION, taskId), {
      userId: payload.userId,
      title,
      priority: sanitizePriority(payload.priority),
      dueDate: sanitizeDueDate(payload.dueDate),
      category: sanitizeCategory(payload.category),
      completed: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return taskId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, docPath);
  }
}

export async function toggleTaskInFirestore(
  taskId: string,
  completed: boolean
): Promise<void> {
  const docPath = `${TASKS_COLLECTION}/${taskId}`;
  try {
    await updateDoc(doc(db, TASKS_COLLECTION, taskId), {
      completed,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, docPath);
  }
}

export interface UpdateTaskPayload {
  title: string;
  priority: Priority;
  dueDate: string;
  category: Category;
}

export async function updateTaskInFirestore(
  taskId: string,
  payload: UpdateTaskPayload
): Promise<void> {
  const title = sanitizeTitle(payload.title);
  if (!title) {
    throw new Error('Task title cannot be empty.');
  }

  const docPath = `${TASKS_COLLECTION}/${taskId}`;
  try {
    await updateDoc(doc(db, TASKS_COLLECTION, taskId), {
      title,
      priority: sanitizePriority(payload.priority),
      dueDate: sanitizeDueDate(payload.dueDate),
      category: sanitizeCategory(payload.category),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, docPath);
  }
}

export async function deleteTaskInFirestore(taskId: string): Promise<void> {
  const docPath = `${TASKS_COLLECTION}/${taskId}`;
  try {
    await deleteDoc(doc(db, TASKS_COLLECTION, taskId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, docPath);
  }
}

export async function clearCompletedTasksInFirestore(
  taskIds: string[]
): Promise<void> {
  if (taskIds.length === 0) return;

  try {
    for (let i = 0; i < taskIds.length; i += 450) {
      const chunk = taskIds.slice(i, i + 450);
      const batch = writeBatch(db);
      for (const taskId of chunk) {
        batch.delete(doc(db, TASKS_COLLECTION, taskId));
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, TASKS_COLLECTION);
  }
}

export async function importLocalTasksToFirestore(
  userId: string,
  localTasks: Task[]
): Promise<void> {
  if (localTasks.length === 0) return;

  try {
    for (let i = 0; i < localTasks.length; i += 450) {
      const chunk = localTasks.slice(i, i + 450);
      const batch = writeBatch(db);
      for (const task of chunk) {
        const cleanTitle = sanitizeTitle(task.title);
        if (!cleanTitle) continue;
        const taskId = createValidTaskId();
        batch.set(doc(db, TASKS_COLLECTION, taskId), {
          userId,
          title: cleanTitle,
          priority: sanitizePriority(task.priority),
          dueDate: sanitizeDueDate(task.dueDate),
          category: sanitizeCategory(task.category),
          completed: Boolean(task.completed),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, TASKS_COLLECTION);
  }
}
