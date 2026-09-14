export function theme(i) {
    switch (i) {
        case 0: return 152.0;
        case 1: return 0.62;
        case 2: return 0.42;
        case 3: return 2.0;
        case 4: return 1240.0;
        case 5: return 17.0;
        case 6: return 22.0;
        case 7: return 16.0;
        default: return -1.0;
    }
}
export function hot_score(votes, answers, views, ageDays) {
    const base = votes * 3 + answers * 5 + views / 100;
    return base / (1 + ageDays / 30);
}
