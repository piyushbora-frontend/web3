type LoggedFetchOptions = RequestInit & {
  logLabel?: string;
};

function escapeForSingleQuotes(value: string) {
  return value.replace(/'/g, `'\\''`);
}

function buildCurl(url: string, init?: RequestInit) {
  const method = (init?.method || "GET").toUpperCase();
  const headers = new Headers(init?.headers || {});
  const headerParts: string[] = [];

  headers.forEach((value, key) => {
    headerParts.push(`--header '${escapeForSingleQuotes(`${key}: ${value}`)}'`);
  });

  let bodyPart = "";
  if (init?.body !== undefined && init?.body !== null) {
    if (typeof init.body === "string") {
      bodyPart = `--data-raw '${escapeForSingleQuotes(init.body)}'`;
    } else if (init.body instanceof URLSearchParams) {
      bodyPart = `--data-raw '${escapeForSingleQuotes(init.body.toString())}'`;
    } else {
      try {
        const jsonBody = JSON.stringify(init.body);
        if (jsonBody) {
          bodyPart = `--data-raw '${escapeForSingleQuotes(jsonBody)}'`;
        }
      } catch {
        // non-serializable body (e.g. stream); skip body in curl
      }
    }
  }

  const methodPart = method === "GET" ? "" : `-X ${method}`;
  return (
    `curl --location '${escapeForSingleQuotes(url)}' ${methodPart} ${headerParts.join(" ")} ${bodyPart}`
      .replace(/\s+/g, " ")
      .trim()
  );
}

async function readResponseBody(res: Response) {
  const cloned = res.clone();
  try {
    return await cloned.json();
  } catch {
    try {
      return await cloned.text();
    } catch {
      return null;
    }
  }
}

export async function loggedFetch(url: string, init?: LoggedFetchOptions) {
  const { logLabel, ...fetchInit } = init || {};
  const curl = buildCurl(url, fetchInit);
  const labelSuffix = logLabel ? ` ${logLabel}` : "";

  console.log(`[API] CURL${labelSuffix}:`, curl);
  const res = await fetch(url, fetchInit);
  const body = await readResponseBody(res);
  console.log(`[API] RESPONSE${labelSuffix}:`, {
    url,
    status: res.status,
    ok: res.ok,
    body,
  });

  return res;
}
