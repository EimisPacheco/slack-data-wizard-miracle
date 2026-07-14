/**
 * Generates a Tableau .twb from a viz spec + a table's columns. The data is embedded as a CSV
 * snapshot inside the .twbx, so the workbook has no live connection.
 *
 * Modelled field-by-field on Tableau's own Superstore / World Indicators workbooks.
 * The load-bearing lessons, learned the hard way:
 *   - Every column needs a <metadata-record>, or the view returns zero rows.
 *   - Every field referenced on a shelf/encoding must appear in <datasource-dependencies>,
 *     or the whole view silently blanks with no error.
 *   - Datasource captions must be unique within a workbook.
 *   - Filled map = Multipolygon + [Geometry (generated)] + generated lat/lon on rows/cols
 *     + a geographic semantic-role on the dimension.
 */

const DS = 'federated.0avizbuilder';
const NC = 'textscan.0avizconn';

// Databricks type -> Tableau (datatype, remote-type code, role, default aggregation)
function tableauType(dbxType) {
  const t = String(dbxType).toLowerCase();
  if (/int|bigint|smallint|tinyint|mediumint/.test(t)) return { dt: 'integer', rt: '20', role: 'measure', agg: 'Sum' };
  if (/double|float|decimal|numeric/.test(t)) return { dt: 'real', rt: '5', role: 'measure', agg: 'Sum' };
  if (/timestamp|datetime/.test(t)) return { dt: 'datetime', rt: '135', role: 'dimension', agg: 'Year' };
  if (/date/.test(t)) return { dt: 'date', rt: '133', role: 'dimension', agg: 'Year' };
  return { dt: 'string', rt: '129', role: 'dimension', agg: 'Count' };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Names the column-instance the way Tableau does: [agg:Field:qk] / [none:Field:nk] / [yr:Field:ok]. */
function instanceName(field, kind) {
  const map = {
    sum: `[sum:${field}:qk]`, avg: `[avg:${field}:qk]`,
    cnt: `[cnt:${field}:qk]`, cntd: `[ctd:${field}:qk]`,
    year: `[yr:${field}:ok]`,
    // truncated dates give a continuous time axis for line charts
    tday: `[tdy:${field}:qk]`, tmonth: `[tmn:${field}:qk]`, tyear: `[tyr:${field}:qk]`,
  };
  return map[kind] || `[none:${field}:nk]`;
}
function derivation(kind) {
  return { sum: 'Sum', avg: 'Avg', cnt: 'Count', cntd: 'CountD', year: 'Year',
    tday: 'Trunc-Day', tmonth: 'Trunc-Month', tyear: 'Trunc-Year', none: 'None' }[kind];
}
function instType(kind) {
  if (kind === 'none') return 'nominal';
  if (kind === 'year') return 'ordinal';
  return 'quantitative';
}
function ref(name) { return `[${DS}].${name}`; }

// What the serializer can express natively. The spec model speaks VizQL; anything it says
// outside this vocabulary triggers the internet-research retry in spec.js rather than a failure.
export const KNOWN_MARKS = new Set(['Automatic', 'Bar', 'Line', 'Area', 'Circle', 'Square', 'Pie', 'Text', 'Shape', 'GanttBar', 'Multipolygon']);
export const KNOWN_DERIVATIONS = new Set(['sum', 'avg', 'cnt', 'cntd', 'year', 'tday', 'tmonth', 'tyear', 'none']);

/**
 * spec = {
 *   table, chartType: 'bar'|'hbar'|'line'|'scatter'|'map'|'table',
 *   dimension, measure, aggregation: 'SUM'|'AVG'|'COUNT'|'COUNTD',
 *   geoField (for map), colorField, sortDir, rowLimit, title
 * }
 * columns = [{ name, type }]  from information_schema
 */
export function generateTwb({ spec, columns }) {
  const table = spec.table;

  const colTypes = Object.fromEntries(columns.map(c => [c.name, tableauType(c.type)]));

  // ---- relation columns + metadata-records for every column ----
  const csvId = `${table}#csv`;
  // A CSV is TEXT. Tableau's own working CSV workbooks declare every relation column — and every
  // metadata-record — as `string`, then re-type at the datasource layer with
  // datatype-customized='true'. Declaring `integer` here instead contradicts what the textscan
  // connector actually hands back, the columns fail to bind, and the view renders BLANK with no
  // error. This mismatch is exactly why every generated workbook came out empty.
  const relationCols = columns.map((c, i) =>
    `            <column datatype='string' name='${esc(c.name)}' ordinal='${i}' />`).join('\n');
  // One object-id per relation, as Tableau writes it — stable, derived from the table name.
  const objectId = `[${esc(table)}_${Buffer.from(table).toString('hex').toUpperCase().padEnd(32, '0').slice(0, 32)}]`;
  const metaRecords = columns.map((c, i) => {
    return `          <metadata-record class='column'>
            <remote-name>${esc(c.name)}</remote-name>
            <remote-type>-1</remote-type>
            <local-name>[${esc(c.name)}]</local-name>
            <parent-name>[${esc(csvId)}]</parent-name>
            <remote-alias>${esc(c.name)}</remote-alias>
            <ordinal>${i}</ordinal>
            <family>${esc(table)}</family>
            <local-type>string</local-type>
            <aggregation>Count</aggregation>
            <width>4096</width>
            <contains-null>true</contains-null>
            <collation flag='0' name='binary' />
            <attributes>
              <attribute datatype='string' name='DebugRemoteType'>&quot;WSTRING&quot;</attribute>
              <attribute datatype='string' name='RemoteTypeName'>&quot;string&quot;</attribute>
              <attribute datatype='boolean' name='filterable_column'>true</attribute>
            </attributes>
            <object-id>${objectId}</object-id>
          </metadata-record>`;
  }).join('\n');

  // ---- decide shelves per chart type ----
  const aggKind = { SUM: 'sum', AVG: 'avg', COUNT: 'cnt', COUNTD: 'cntd' }[(spec.aggregation || 'SUM').toUpperCase()] || 'sum';

  // fields that must be declared (column defs + instances + dependencies)
  const used = new Map(); // fieldName -> Set of kinds
  const use = (f, kind) => { if (!used.has(f)) used.set(f, new Set()); used.get(f).add(kind); };

  let mark, rows = '', cols = '', encodings = '', geo = false;

  const measureInst = ref(instanceName(spec.measure, aggKind));
  const dimIsDate = spec.dimension && /date|datetime/.test(colTypes[spec.dimension]?.dt || '');
  // Line charts want a continuous truncated date; categorical charts want discrete year.
  const dateGran = { day: 'tday', month: 'tmonth', year: spec.chartType === 'line' ? 'tyear' : 'year' }[spec.dateGranularity || (spec.chartType === 'line' ? 'day' : 'year')];
  const dimKind = dimIsDate ? dateGran : 'none';
  const dimInst = spec.dimension ? ref(instanceName(spec.dimension, dimKind)) : null;

  // ---- native VizQL: the model placed fields on shelves itself ----
  if (spec.vizql) {
    const v = spec.vizql;
    mark = KNOWN_MARKS.has(v.mark) ? v.mark : 'Automatic';
    const shelfRef = it => {
      const k = KNOWN_DERIVATIONS.has(it.derivation) ? it.derivation : 'none';
      use(it.field, k);
      return ref(instanceName(it.field, k));
    };
    const join = list => {
      const refs = (list || []).filter(it => it && it.field).map(shelfRef);
      return refs.length > 1 ? `(${refs.join(' / ')})` : (refs[0] || '');
    };
    cols = join(v.cols);
    rows = join(v.rows);
    const TAG = { color: 'color', size: 'size', label: 'text', text: 'text', detail: 'lod', shape: 'shape' };
    for (const e of v.encodings || []) {
      const tag = TAG[String(e.shelf || '').toLowerCase()];
      if (!tag || !e.field) continue;
      encodings += `\n              <${tag} column='${shelfRef(e)}' />`;
    }
  } else switch (spec.chartType) {
    case 'bar':
      mark = 'Bar';
      use(spec.dimension, dimKind); use(spec.measure, aggKind);
      cols = dimInst; rows = measureInst;
      break;
    case 'hbar':
      mark = 'Bar';
      use(spec.dimension, dimKind); use(spec.measure, aggKind);
      rows = dimInst; cols = measureInst;
      break;
    case 'line':
      mark = 'Line';
      use(spec.dimension, dimKind); use(spec.measure, aggKind);
      cols = dimInst; rows = measureInst;
      break;
    case 'area':
      mark = 'Area';
      use(spec.dimension, dimKind); use(spec.measure, aggKind);
      cols = dimInst; rows = measureInst;
      break;
    case 'pie':
      // A pie lives entirely on the marks card: nothing on rows/cols, the category on
      // color and the measure on the wedge size/angle. Labels carry the category and its
      // share of the total (a table-calc field added below).
      mark = 'Pie';
      use(spec.dimension, 'none'); use(spec.measure, aggKind);
      rows = ''; cols = '';
      encodings += `\n              <color column='${dimInst}' />`;
      encodings += `\n              <size column='${measureInst}' />`;
      encodings += `\n              <text column='${dimInst}' />`;
      encodings += `\n              <text column='${ref('[usr:Calculation_PctOfTotal:nk]')}' />`;
      break;
    case 'scatter': {
      mark = 'Circle';
      const m2Inst = ref(instanceName(spec.measure2 || spec.measure, aggKind));
      use(spec.measure, aggKind); use(spec.measure2 || spec.measure, aggKind);
      cols = measureInst; rows = m2Inst;
      if (spec.dimension) { use(spec.dimension, 'none'); encodings += `\n              <lod column='${ref(instanceName(spec.dimension, 'none'))}' />`; }
      break;
    }
    case 'map': {
      mark = 'Multipolygon'; geo = true;
      const geoField = spec.geoField || spec.dimension;
      use(geoField, 'none');
      rows = ref('[Latitude (generated)]'); cols = ref('[Longitude (generated)]');
      encodings += `\n              <lod column='${ref(instanceName(geoField, 'none'))}' />`;
      encodings += `\n              <geometry column='${ref('[Geometry (generated)]')}' />`;
      if (spec.colorField) { use(spec.colorField, 'none'); encodings += `\n              <color column='${ref(instanceName(spec.colorField, 'none'))}' />`; }
      break;
    }
    case 'table':
    default:
      mark = 'Text';
      use(spec.dimension, 'none'); use(spec.measure, aggKind);
      rows = dimInst; cols = measureInst;
      encodings += `\n              <text column='${measureInst}' />`;
      break;
  }
  // pie already put its dimension on color, and a vizql spec manages its own encodings.
  if (spec.colorField && !spec.vizql && spec.chartType !== 'map' && spec.chartType !== 'pie') { use(spec.colorField, 'none'); encodings += `\n              <color column='${ref(instanceName(spec.colorField, 'none'))}' />`; }

  // ---- build column defs + instances + dependency block from `used` ----
  const colDefs = [];
  const instances = [];
  for (const [field, kinds] of used) {
    const tt = colTypes[field];
    if (!tt) throw new Error(`spec references unknown column "${field}"`);
    const geoAttr = (geo && field === (spec.geoField || spec.dimension)) ? ` semantic-role='[Country].[ISO3166_2]'` : '';
    // The relation says every column is `string` (a CSV is text). This is the layer that re-types
    // it — and Tableau requires datatype-customized='true' to accept a type that differs from
    // what the connection reported. Without it the cast is ignored and the measure never binds.
    const custom = tt.dt === 'string' ? '' : ` datatype-customized='true'`;
    colDefs.push(`    <column datatype='${tt.dt}'${custom} default-format='0' name='[${esc(field)}]' role='${tt.role}' type='${tt.dt === 'string' || tt.dt === 'date' || tt.dt === 'datetime' ? 'nominal' : 'quantitative'}'${geoAttr} />`);
    for (const k of kinds) {
      instances.push(`    <column-instance column='[${esc(field)}]' derivation='${derivation(k)}' name='${instanceName(field, k)}' pivot='key' type='${instType(k)}' />`);
    }
  }
  // Pie: "% of total" is a table-calculated field, declared alongside the real columns.
  if (spec.chartType === 'pie' && !spec.vizql) {
    // LOD ({ SUM(x) } = table-wide total) computes the share; the calc RETURNS the formatted
    // label string itself ("39.0%") because default-format on a calc column doesn't reach
    // mark labels reliably.
    colDefs.push(`    <column caption='% of Total' datatype='string' name='[Calculation_PctOfTotal]' role='measure' type='nominal'>
      <calculation class='tableau' formula='STR(ROUND(SUM([${esc(spec.measure)}])/MIN({ SUM([${esc(spec.measure)}]) })*100,1)) + "%"' />
    </column>`);
    instances.push(`    <column-instance column='[Calculation_PctOfTotal]' derivation='User' name='[usr:Calculation_PctOfTotal:nk]' pivot='key' type='nominal' />`);
  }
  const deps = [...colDefs, ...instances].map(l => '      ' + l.trim()).join('\n');

  // Labels on marks need an explicit style rule or Tableau hides them; a color encoding
  // earns a legend card in the window so readers can decode the palette.
  const hasText = encodings.includes('<text ');
  const colorParam = (encodings.match(/<color column='([^']+)'/) || [])[1] || null;
  const styleBlock = hasText ? `
        <style>
          <style-rule element='mark'>
            <format attr='mark-labels-show' value='true' />
          </style-rule>
        </style>` : '';
  const legendCard = colorParam
    ? `<edge name='right'><strip size='160'><card pane-specification-id='0' param='${colorParam}' type='color' /></strip></edge>`
    : '';

  const title = spec.title || `${spec.aggregation || ''} ${spec.measure || ''} by ${spec.dimension || ''}`.trim();

  return `<?xml version='1.0' encoding='utf-8' ?>
<workbook original-version='18.1' source-build='2023.1.0' source-platform='mac' version='18.1' xmlns:user='http://www.tableausoftware.com/xml/user'>
  <datasources>
    <datasource caption='${esc(table)}' inline='true' name='${DS}' version='18.1'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='${esc(table)}' name='${NC}'>
            <connection class='textscan' directory='Data' filename='${esc(table)}.csv' server='' />
          </named-connection>
        </named-connections>
        <relation connection='${NC}' name='${esc(table)}.csv' table='[${esc(csvId)}]' type='table'>
          <columns CommonHasHeaderRow='true'>
${relationCols}
          </columns>
        </relation>
        <metadata-records>
${metaRecords}
        </metadata-records>
      </connection>
${colDefs.join('\n')}
${instances.join('\n')}
    </datasource>
  </datasources>
  <worksheets>
    <worksheet name='${esc(spec.sheetName || 'Viz')}'>
      <table>
        <view>
          <datasources>
            <datasource caption='${esc(table)}' name='${DS}' />
          </datasources>
          <datasource-dependencies datasource='${DS}'>
${deps}
          </datasource-dependencies>
          <aggregation value='true' />
        </view>${styleBlock}
        <panes>
          <pane selection-relaxation-option='selection-relaxation-allow'>
            <view><breakdown value='auto' /></view>
            <mark class='${mark}' />
            <encodings>${encodings}
            </encodings>
          </pane>
        </panes>
        <rows>${rows}</rows>
        <cols>${cols}</cols>
      </table>
      <simple-id uuid='{a1b2c3d4-0001-0001-0001-000000000001}' />
    </worksheet>
  </worksheets>
  <windows source-height='30'>
    <window class='worksheet' maximized='true' name='${esc(spec.sheetName || 'Viz')}'>
      <cards><edge name='left'><strip size='160'>
        <card type='pages' /><card type='filters' /><card type='marks' />
      </strip></edge>${legendCard}</cards>
      <simple-id uuid='{a1b2c3d4-0002-0002-0002-000000000002}' />
    </window>
  </windows>
</workbook>
`;
}
