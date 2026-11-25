export const PRIORITIES = ['Low', 'Medium', 'High'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const CATEGORIES = [
  'Work',
  'Personal',
  'Urgent',
  'Errands',
  'General',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type FilterStatus = 'all' | 'active' | 'completed';
export type SortOption = 'newest' | 'dueDate' | 'priority';
export type ThemeMode = 'light' | 'dark';

export interface Task {
  id: string;
  title: string;
  priority: Priority;
  dueDate: string;
  category: Category;
  completed: boolean;
  createdAt: number;
}
