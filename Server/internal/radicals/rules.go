package radicals

import "slices"

// The fixed rules of the exercise, as settled in the Python KIT through HSK 1 and 2.

// setOf makes a set of the runes of each argument.
func setOf(parts ...string) map[string]bool {
	set := map[string]bool{}
	for _, part := range parts {
		for _, r := range part {
			set[string(r)] = true
		}
	}
	return set
}

var (
	// standardRadicals are always allowed as an answer.
	standardRadicals = func() map[string]bool {
		set := setOf("亻讠氵扌忄犭饣钅纟礻艹宀广疒辶冫阝刂灬彳冖冂囗门走爫亠穴户匕耂木王田贝夕欠禾矢弓虫勹攵衤")
		set["学字头"] = true
		return set
	}()

	// singleStrokes are never an answer.
	singleStrokes = setOf("一丨丿丶丷乚乛亅乙二三⺊")

	// hardExcluded characters are kept out of the questions: disputed split, or the remaining part is meaningless
	// or only one stroke.
	hardExcluded = setOf(
		"真气白半子不车出电大生东西书多儿二飞非兴哥个工小火斤弟我司几今年九开以口来师了买关系米面午么十日三上下水习衣月再中也五王手牛人八女士一七千事两亮商得能朋",
		"夫表丈头肉网乐")

	// familiarChars stand alone as a character beginners have met, so they are allowed as an answer.
	familiarChars = setOf("口日月木水火土金山石田目耳手足心力刀又寸工巾己干门尸弓女子父母贝见立白皮禾米竹羊鱼虫鸟马牛羽衣西" +
		"人大小天夫门车言食云雨电自方明正生用也长非青欠止")
)

// similarPairs look so alike that they never share a group: the confusion would come from shape, not knowledge.
var similarPairs = [][2]string{
	{"囗", "口"}, {"冖", "宀"}, {"氵", "冫"}, {"亻", "彳"}, {"日", "目"}, {"木", "禾"}, {"刀", "力"}, {"八", "人"}, {"儿", "几"},
	{"扌", "才"}, {"又", "夂"}, {"土", "士"}, {"己", "巳"}, {"匕", "七"}, {"大", "太"}, {"广", "疒"}, {"户", "尸"}, {"田", "由"}, {"王", "玉"},
}

// charPair is a (character, component) pair.
type charPair struct{ char, component string }

// hiddenNever are pairs not used as an answer because the split is uncommon or easy to dispute.
var hiddenNever = map[charPair]bool{
	{"在", "才"}: true, {"色", "巴"}: true, {"让", "上"}: true, {"啊", "阿"}: true, {"交", "六"}: true, {"学", "学字头"}: true,
}

// roleSkipped pairs get no semantic or phonetic role because the dictionary is unsure.
var roleSkipped = map[charPair]bool{
	{"有", "月"}: true, {"可", "丁"}: true, {"医", "匸"}: true, {"医", "矢"}: true, {"雪", "彐"}: true, {"穿", "穴"}: true,
	{"穿", "牙"}: true, {"让", "上"}: true, {"礼", "乚"}: true, {"就", "尤"}: true, {"就", "京"}: true,
}

// splitRule says which strokes of a character belong to a component, overriding the dictionary's own split.
type splitRule struct {
	name    string
	paths   [][]int // strokes whose decomposition path starts with one of these
	unmatch bool    // strokes the dictionary matches to no component
	strokes []int   // explicit stroke indexes
}

// strokesIn picks the strokes the rule names, given the dictionary's match of each stroke to a decomposition path.
func (r splitRule) strokesIn(matches [][]int) []int {
	if r.strokes != nil {
		return slices.Clone(r.strokes)
	}
	var picked []int
	for i, path := range matches {
		switch {
		case r.unmatch:
			if path == nil {
				picked = append(picked, i)
			}
		case len(path) > 0 && slices.ContainsFunc(r.paths, func(prefix []int) bool {
			return len(path) >= len(prefix) && slices.Equal(path[:len(prefix)], prefix)
		}):
			picked = append(picked, i)
		}
	}
	return picked
}

func viaPaths(name string, paths ...[]int) splitRule { return splitRule{name: name, paths: paths} }
func viaUnmatched(name string) splitRule             { return splitRule{name: name, unmatch: true} }
func viaStrokes(name string, strokes ...int) splitRule {
	return splitRule{name: name, strokes: strokes}
}

var splitOverrides = map[string][]splitRule{
	"爱": {viaPaths("爫", []int{0, 0}), viaPaths("冖", []int{0, 1}), viaPaths("友", []int{1})},
	"茶": {viaPaths("艹", []int{0}), viaPaths("人", []int{1, 0}), viaPaths("木", []int{1, 1})},
	"学": {viaPaths("学字头", []int{0, 0}, []int{0, 1}), viaPaths("子", []int{1})},
	"觉": {viaPaths("学字头", []int{0}, []int{1}), viaPaths("见", []int{2})},
	"贵": {viaPaths("中", []int{0, 0}), viaPaths("一", []int{0, 1}), viaPaths("贝", []int{1})},
	"那": {viaUnmatched("冄"), viaPaths("阝", []int{1})},
	"脑": {viaPaths("月", []int{0}), viaPaths("脑右", []int{1})},
	"服": {viaPaths("月", []int{0}), viaPaths("服右", []int{1})},
	"有": {viaUnmatched("𠂇"), viaPaths("月", []int{1})},
	"后": {viaUnmatched("𠂆"), viaPaths("口", []int{1})},
	"友": {viaUnmatched("𠂇"), viaPaths("又", []int{1})},
	"先": {viaUnmatched("𠂉"), viaPaths("土", []int{0, 1}), viaPaths("儿", []int{1})},
	"前": {viaPaths("前字头", []int{0, 0}, []int{0, 1}), viaStrokes("月", 3, 4, 5, 6), viaStrokes("刂", 7, 8)},
	"弟": {viaPaths("丷", []int{0}), viaPaths("弓", []int{1, 0}), viaUnmatched("丿")},
	"经": {viaStrokes("纟", 0, 1, 2), viaStrokes("巠", 3, 4, 5, 6, 7)},
	"往": {viaStrokes("彳", 0, 1, 2), viaStrokes("主", 3, 4, 5, 6, 7)},
	"周": {viaPaths("冂", []int{0}), viaPaths("吉", []int{1})},
	"望": {viaPaths("亡", []int{0, 0}), viaPaths("月", []int{0, 1}), viaPaths("王", []int{1})},
	"妻": {viaPaths("妻字头", []int{0}), viaPaths("女", []int{1})},
	"同": {viaStrokes("冂", 0, 1), viaStrokes("一", 2), viaStrokes("口", 3, 4, 5)},
}

// pseudoComponents have no character of their own to draw them from: the shape is taken from a source character.
var pseudoComponents = map[string]string{
	"⺮": "第", "矦": "候", "耂": "老", "学字头": "学", "前字头": "前", "𠂇": "友", "𠂆": "后", "𠂉": "先",
	"冄": "那", "脑右": "脑", "服右": "服", "妻字头": "妻", "巠": "经",
}

// structureNames are how the page words the shape of a character, by its Ideographic Description operator.
var structureNames = map[rune]string{
	'⿰': "Trái – phải", '⿱': "Trên – dưới", '⿲': "Trái – giữa – phải", '⿳': "Trên – giữa – dưới",
	'⿴': "Bao kín", '⿵': "Bao ba phía (hở dưới)", '⿶': "Bao ba phía (hở trên)", '⿷': "Bao ba phía (hở phải)",
	'⿸': "Bao nửa (từ trên-trái)", '⿹': "Bao nửa (từ trên-phải)", '⿺': "Bao nửa (từ dưới-trái)", '⿻': "Đan xen",
}
