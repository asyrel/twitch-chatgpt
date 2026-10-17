// Fake luscious.net GraphQL API for tests. Includes deliberately tricky data:
// real-photo albums, gay/futa/furry albums, a minor-related tag, an unknown field ("category").
import http from 'node:http';
import { buildSchema, graphql } from 'graphql';

const CT = [{ id: '1', title: 'Hentai' }, { id: '2', title: 'Real People' }, { id: '3', title: 'Non-Erotic' }];
const AUD = [{ id: '10', title: 'Straight Sex' }, { id: '11', title: 'Gay / Yaoi' }, { id: '12', title: 'Futanari' }, { id: '13', title: 'Furries' }, { id: '14', title: 'Lesbian / Yuri' }];
const SORTS = ['date_trending', 'date_newest', 'date_last_interaction', 'rating_7_days', 'rating_30_days', 'rating_365_days', 'rating_all_time', 'view_count_30_days', 'view_count_all_time', 'search_score'];
const FAVS = ['3', '4', '5', '6', '8', '9'];

export function startLuscious(port) {
  const base = `http://127.0.0.1:${port}`;
  const albums = Array.from({ length: 40 }, (_, i) => {
    const n = i + 1;
    const manga = n % 4 === 0;
    const real = !manga && n % 3 === 0;
    const aud = n === 5 ? AUD[1] : n === 7 ? AUD[2] : n === 8 ? AUD[3] : n === 10 ? AUD[4] : AUD[0];
    return {
      id: String(n), title: (manga ? 'Manga ' : real ? 'Real ' : 'Hentai ') + n, number_of_pictures: manga ? 24 : 4, is_manga: manga,
      cover: { url: `${base}/img/cover.png` }, tags: [{ text: n === 11 ? 'yaoi' : n === 13 ? 'loli' : 'tag' }], genres: [],
      content: real ? CT[1] : CT[0], audiences: [aud],
      created_by: n % 2 ? { id: '77', name: 'artista', display_name: 'ArtistA' } : { id: '78', name: 'artistb', display_name: 'ArtistB' },
    };
  });
  // Note: Tag has no "category" field on purpose (the app asks for it and must recover).
  const schema = buildSchema(`
    type Cover { url: String } type Tag { text: String } type Lang { title: String }
    type U { id: ID! name: String display_name: String }
    type Ref { id: ID title: String }
    type Album { id: ID! title: String url: String description: String number_of_pictures: Int number_of_animated_pictures: Int is_manga: Boolean cover: Cover tags: [Tag] genres: [Ref] audiences: [Ref] content: Ref language: Lang created_by: U }
    type MC { content_types: [Ref] audiences: [Ref] genres: [Ref] }
    type Info { page: Int has_next_page: Boolean total_items: Int total_pages: Int }
    type AlbumList { info: Info items: [Album] }
    input Filter { name: String! value: String! }
    input AlbumListInput { display: String filters: [Filter] page: Int }
    input PictureListInput { display: String filters: [Filter] page: Int }
    type Error { code: String message: String } type MutationError { errors: [Error] }
    union AlbumResult = Album | MutationError
    type Thumb { width: Int url: String }
    type PicAlbum { id: ID title: String }
    type Picture { album: PicAlbum tags: [Tag] id: ID! title: String position: Int is_animated: Boolean url_to_original: String url_to_video: String download_url: String thumbnails: [Thumb] }
    type PicList { info: Info items: [Picture] }
    type UserProfile { id: ID user: U number_of_albums: Int number_of_favorite_albums: Int }
    union ProfileResult = UserProfile | MutationError
    union LoginResult = U | MutationError
    input LoginInput { login: String! password: String! remember: Boolean }
    type AlbumQ { list(input: AlbumListInput!): AlbumList get(id: ID!): AlbumResult }
    type PictureQ { list(input: PictureListInput!): PicList }
    type ProfileQ { get(user_id: ID!): ProfileResult }
    type UserQ { me: U }
    type UserM { login(input: LoginInput!): LoginResult }
    type Query { album: AlbumQ picture: PictureQ userprofile: ProfileQ media_categories: MC user: UserQ }
    type Mutation { user: UserM }`);
  const page = (arr, p = 1, n = 10) => ({ info: { page: p, has_next_page: p * n < arr.length, total_items: arr.length }, items: arr.slice((p - 1) * n, p * n) });
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/page/')) {
      const n = +req.url.match(/_(\d+)/)[1];
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1150"><rect width="100%" height="100%" fill="#f4f0e6"/><text x="400" y="560" font-size="200" text-anchor="middle" fill="#222">${n}</text></svg>`);
    }
    if (req.url.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const { query, variables } = JSON.parse(body || '{}');
      const authed = /sessionid=good/.test(req.headers.cookie || '');
      const setCookie = [];
      const root = {
        album: {
          list: ({ input }) => {
            if (input.display && !SORTS.includes(input.display)) throw new Error('Invalid display: ' + input.display);
            let arr = albums;
            if (input.display) { const k = SORTS.indexOf(input.display) + 1; arr = [...arr].sort((a, b) => ((+a.id * k * 7919) % 101) - ((+b.id * k * 7919) % 101)); }
            for (const f of input.filters || []) {
              if (f.name === 'favorite_by_user_id') arr = f.value === '42' ? arr.filter((a) => FAVS.includes(a.id)) : [];
              if (f.name === 'search_query') arr = arr.filter((a) => a.title.includes(f.value));
              if (f.name === 'album_type') arr = arr.filter((a) => a.is_manga === (f.value === 'manga'));
              if (f.name === 'content_id') arr = arr.filter((a) => a.content.id === f.value);
              if (f.name === 'created_by_id') arr = arr.filter((a) => a.created_by.id === f.value);
            }
            return page(arr, input.page);
          },
          get: ({ id }) => { const a = albums.find((x) => x.id === id); return a ? { __typename: 'Album', ...a } : { __typename: 'MutationError', errors: [{ message: 'Album not found' }] }; },
        },
        media_categories: { content_types: CT, audiences: AUD, genres: [] },
        picture: {
          list: ({ input }) => {
            const f = input.filters?.[0];
            if (!f) throw new Error('filter required');
            if (f.name === 'search_query') {
              return page(Array.from({ length: 30 }, (_, i) => ({ id: 'p' + i, title: 'ref' + i, url_to_original: `${base}/page/9_${i + 1}.svg`, thumbnails: [{ width: 315, url: `${base}/img/t.png` }], album: { id: String((i % 5) + 1), title: 'Hentai ' + ((i % 5) + 1) }, tags: [{ text: i === 3 ? 'yaoi' : f.value }] })), input.page, 12);
            }
            const n = albums.find((a) => a.id === f.value)?.number_of_pictures || 4;
            return page(Array.from({ length: n }, (_, i) => ({ id: String(i), title: `p${i}.png`, url_to_original: `${base}/page/${f.value}_${i + 1}.svg`, thumbnails: [{ width: 315, url: `${base}/img/t.png` }] })), input.page, 50);
          },
        },
        userprofile: {
          get: ({ user_id }) => ['77', '78'].includes(user_id)
            ? { __typename: 'UserProfile', id: user_id, user: { id: user_id, name: 'a', display_name: user_id === '77' ? 'ArtistA' : 'ArtistB' }, number_of_albums: 20, number_of_favorite_albums: 0 }
            : user_id === '42' ? { __typename: 'UserProfile', id: '42', user: { id: '42', name: 'bob', display_name: 'Bob' }, number_of_favorite_albums: 6 }
              : { __typename: 'MutationError', errors: [{ message: 'User not found' }] },
        },
        user: {
          me: () => (authed ? { id: '42', name: 'bob', display_name: 'Bob' } : null),
          login: ({ input }) => {
            if (input.login === 'bob' && input.password === 'pw') { setCookie.push('sessionid=good; Path=/'); return { __typename: 'U', id: '42', name: 'bob' }; }
            return { __typename: 'MutationError', errors: [{ code: 'bad', message: 'Wrong username or password' }] };
          },
        },
      };
      const r = await graphql({ schema, source: query, rootValue: root, variableValues: variables, typeResolver: (v) => v.__typename });
      res.writeHead(200, { 'content-type': 'application/json', ...(setCookie.length ? { 'set-cookie': setCookie } : {}) });
      res.end(JSON.stringify(r));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
