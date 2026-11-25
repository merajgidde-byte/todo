# Security Specification — Taskline Firestore

## 1. Data Invariants
1. **Unauthenticated & Unverified Denial**: No read or write operation is permitted unless `request.auth != null` and `request.auth.token.email_verified == true`.
2. **Strict Ownership**: Every task document in `/tasks/{taskId}` MUST have `userId == request.auth.uid` on creation, and only the owning user may `get`, `list`, `update`, or `delete` that document.
3. **Immutable Ownership & Creation Time**: `userId` and `createdAt` cannot be modified after document creation.
4. **Server Timestamp Integrity**: `createdAt` on create and `updatedAt` on create/update must equal `request.time`.
5. **Strict Schema & Bounds**: Task documents allow only `['userId', 'title', 'priority', 'dueDate', 'category', 'completed', 'createdAt', 'updatedAt']` with strict types, enum values, regex patterns, and bounded string lengths (`title` 1–180 chars, `dueDate` `""` or `YYYY-MM-DD`, `userId` and `taskId` `^[a-zA-Z0-9_-]+$` up to 128 chars).
6. **Action-Scoped Updates**: Updates must match either the completion-toggle action (`['completed', 'updatedAt']`) or the task-edit action (`['title', 'priority', 'dueDate', 'category', 'updatedAt']`).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: Read or create a task when `request.auth == null` -> `PERMISSION_DENIED`.
2. **Unverified Email Write**: Create a task when `request.auth.token.email_verified == false` -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Create**: User A creates `/tasks/task_1` with `userId: "user_B"` -> `PERMISSION_DENIED`.
4. **Cross-Tenant Get/Delete**: User A attempts to `get` or `delete` User B's task -> `PERMISSION_DENIED`.
5. **Blanket List Query**: User A runs `getDocs(collection(db, 'tasks'))` without `where('userId', '==', userA.uid)` -> `PERMISSION_DENIED`.
6. **Ghost / Shadow Field Injection**: Create or update a task with an extra field (`isAdmin: true` or `sharedWith: ['all']`) -> `PERMISSION_DENIED`.
7. **ID Poisoning**: Create a task with a 1,500-character document ID or invalid characters (`task$../bad`) -> `PERMISSION_DENIED`.
8. **Empty or Oversized Title**: Create or update a task with `title: ""` or `title.length > 180` -> `PERMISSION_DENIED`.
9. **Invalid Priority or Category Enum**: Create or update a task with `priority: "Critical"` or `category: "Admin"` -> `PERMISSION_DENIED`.
10. **Malformed Due Date**: Create or update a task with `dueDate: "tomorrow"` or `dueDate` > 10 chars -> `PERMISSION_DENIED`.
11. **Client-Spoofed Timestamp**: Create or update a task with a client-supplied past/future `createdAt` or `updatedAt` instead of `serverTimestamp()` -> `PERMISSION_DENIED`.
12. **Immutable Field Tampering**: Update an existing task's `userId` or `createdAt` -> `PERMISSION_DENIED`.
