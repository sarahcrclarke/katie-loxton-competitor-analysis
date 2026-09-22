import { getLatestSuccessfulCapture } from "@/lib/captures";

export const dynamic = "force-dynamic";

export default async function Home() {
  const capture = await getLatestSuccessfulCapture("strathberry");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center gap-8 px-6 py-12">
      <header className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Katie Loxton Competitor Analysis
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          Proof of concept — automated mobile homepage capture for
          Strathberry.
        </p>
      </header>

      <section className="w-full">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Strathberry — latest capture
        </h2>

        {capture ? (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            {capture.screenshotPaths.map((screenshotPath) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={screenshotPath}
                src={`/${screenshotPath.replace(/^public\//, "")}`}
                alt="Strathberry mobile homepage screenshot"
                className="w-full"
              />
            ))}
            <dl className="grid grid-cols-2 gap-2 border-t border-gray-200 p-4 text-xs text-gray-600">
              <dt className="font-medium">URL</dt>
              <dd className="truncate">{capture.url}</dd>
              <dt className="font-medium">Captured</dt>
              <dd>{new Date(capture.timestamp).toUTCString()}</dd>
              <dt className="font-medium">Viewport</dt>
              <dd>{capture.viewport.label}</dd>
            </dl>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center text-sm text-gray-500">
            No successful capture yet. Trigger the &ldquo;Capture
            Strathberry&rdquo; workflow in GitHub Actions to generate the
            first screenshot.
          </div>
        )}
      </section>
    </main>
  );
}
