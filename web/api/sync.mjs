import { syncRequest } from '../lib/http.mjs';
export async function POST(request) { return syncRequest(request); }
export async function GET(request) { return syncRequest(request); }
